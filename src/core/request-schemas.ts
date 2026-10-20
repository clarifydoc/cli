/**
 * Request schema per endpoint — the join ClarifyDoc had every piece of and
 * never made: a route's body-bound parameter names a class, the class has
 * properties with types, its `extends` names a base with more, and the
 * language plugin knows how each type serializes. Flattened, that is the
 * OpenAPI-shaped `requestSchema` a caller needs to build a valid request.
 *
 * Project-level and in-memory, like `resolveRouterMounts`: it reads the
 * aggregated route rows plus every file's classes and writes `requestSchema`
 * onto the rows that go into `routeMap`. Nothing language-specific lives
 * here — the plugin's `requestSchema` hooks say what a type text means and
 * what a property is called on the wire; this file owns the recursion, the
 * class lookup and the inheritance walk.
 *
 * Bounded on purpose: nested objects are inlined to `MAX_DEPTH`, inheritance
 * is followed `MAX_BASES` levels, and anything unresolved (an enum, a type
 * from a package, a cycle, a cut branch) is a `$ref` by name so the consumer
 * can look it up in `classes` instead of getting a wrong shape.
 */

import type {
  ClassInfo,
  FileAnalysis,
  FunctionInfo,
  JsonSchemaNode,
  RouteInfo,
  RouteParamBinding,
  RouteParamInfo,
} from "../types/analysis.js";
import type { RequestSchemaHooks } from "../types/language-plugin.js";
import { pluginFor } from "../extractors/registry.js";
import { pathParamNames, pathParamTokens } from "../extractors/shared/route-metadata.js";

const MAX_DEPTH = 4;
const MAX_BASES = 5;

/** Last segment of a qualified name: `MyApp.Accounts.User` / `App\\Dto\\User` / `A::B::C` → the leaf. */
function leafName(name: string): string {
  return name.split(/[.\\]|::/).pop() ?? name;
}

type RouteRow = RouteInfo & { filePath: string; projectId?: string; requestSchema?: JsonSchemaNode; responseSchema?: JsonSchemaNode };

interface ClassRef {
  cls: ClassInfo;
  filePath: string;
  projectId: string;
}

interface HandlerRef {
  fn: FunctionInfo;
  filePath: string;
}

/**
 * Give every api route that has no `params` of its own the parameters of the
 * function it dispatches to. Route registrations in Express, Laravel, Rails,
 * Go, Vapor, Phoenix, … name a handler that is declared elsewhere — same file
 * or another — so the extractor could not see its signature. This join finds
 * that function (same file first, then `Class#method` / `Class.method` /
 * `pkg.Func` by name within the sub-project, then a project-wide unique name)
 * and derives the bindings: path tokens → route, the plugin's `bindParam`
 * for typed signatures, plus whatever the body reads (`fn.requestAccess`).
 * Everything here is `inferred`. Returns how many routes were filled.
 */
export function attachHandlerParams(routes: RouteRow[], analyses: FileAnalysis[]): number {
  const byFile = new Map<string, FileAnalysis>();
  const byName = new Map<string, HandlerRef[]>(); // leaf name → every function/method
  const byQualified = new Map<string, HandlerRef[]>(); // Class.method → methods
  const knownClasses = new Set<string>(); // leaf class names anywhere in the project
  const projectOf = new Map<string, string>();
  for (const a of analyses) {
    byFile.set(a.filePath, a);
    projectOf.set(a.filePath, a.projectId ?? "root");
    const add = (map: Map<string, HandlerRef[]>, key: string, ref: HandlerRef) => {
      const list = map.get(key) ?? [];
      list.push(ref);
      map.set(key, list);
    };
    for (const fn of a.functions ?? []) add(byName, fn.name, { fn, filePath: a.filePath });
    for (const cls of a.classes ?? []) {
      // `MyAppWeb.UserController` is also `UserController`: handlers name the
      // leaf, module systems name the path.
      const leaf = leafName(cls.name);
      knownClasses.add(leaf);
      for (const m of cls.methods ?? []) {
        const ref = { fn: m, filePath: a.filePath };
        add(byName, m.name, ref);
        add(byQualified, `${cls.name}.${m.name}`, ref);
        if (leaf !== cls.name) add(byQualified, `${leaf}.${m.name}`, ref);
      }
    }
  }

  const inProject = (refs: HandlerRef[] | undefined, projectId: string): HandlerRef[] => {
    if (!refs || refs.length === 0) return [];
    const local = refs.filter((r) => projectOf.get(r.filePath) === projectId);
    return local.length > 0 ? local : refs;
  };
  const uniqueInProject = (refs: HandlerRef[] | undefined, projectId: string): HandlerRef | null => {
    const local = inProject(refs, projectId);
    return local.length === 1 ? local[0]! : null;
  };
  /** Whether a function looks like a request handler: reads the request, or takes a framework-injected object. */
  const handlerShaped = (ref: HandlerRef, route: RouteRow): boolean => {
    if (ref.fn.requestAccess?.length) return true;
    const lang = byFile.get(ref.filePath)?.language;
    const hooks = lang ? pluginFor(lang)?.requestSchema : undefined;
    if (!hooks?.bindParam) return false;
    return (ref.fn.params ?? []).some((p) => !p.isReceiver && hooks.bindParam!(p, route) === "services");
  };
  /**
   * `handler.ListProducts` vs `store.ListProducts`: a leaf name several
   * packages share. Two language-agnostic tie-breakers, in order — the
   * qualifier names a directory or file (`handler` → `handler/products.go`),
   * then only one candidate is handler-shaped (`h.ListUsers`, where the
   * receiver variable names nothing).
   */
  const disambiguate = (refs: HandlerRef[], qualifier: string, route: RouteRow): HandlerRef | null => {
    if (refs.length === 1) return refs[0]!;
    if (refs.length === 0) return null;
    const q = qualifier.toLowerCase();
    const byPath = refs.filter((r) => {
      const parts = r.filePath.toLowerCase().split("/");
      const base = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
      return parts.slice(0, -1).includes(q) || base === q;
    });
    if (byPath.length === 1) return byPath[0]!;
    const pool = byPath.length > 1 ? byPath : refs;
    const shaped = pool.filter((r) => handlerShaped(r, route));
    return shaped.length === 1 ? shaped[0]! : null;
  };

  const resolve = (route: RouteRow): HandlerRef | null => {
    const handler = route.handler;
    if (!handler) return null;
    const projectId = route.projectId ?? "root";
    // `Class#method`, `Class@method`, `Class.method`, `Class::method`.
    const qualified = handler.match(/^([\w.\\]+)[#@]([\w]+)$/) ?? handler.match(/^([\w\\]+)(?:::|\.)([\w]+)$/);
    if (qualified) {
      const cls = qualified[1]!.split(/[.\\]/).pop()!;
      const method = qualified[2]!;
      const hit = uniqueInProject(byQualified.get(`${cls}.${method}`), projectId);
      if (hit) return hit;
      // The class exists but has no such method here (or several do): a
      // same-named method on ANOTHER class is not this handler.
      if (knownClasses.has(cls)) return null;
      // `pkg.Func` / `h.GetUser` — a free function or method whose receiver we
      // cannot name from the route line: the leaf within the sub-project,
      // disambiguated by the qualifier and the handler shape.
      return disambiguate(inProject(byName.get(method), projectId), cls, route);
    }
    // Bare name: this file first, then the sub-project.
    const own = byFile.get(route.filePath);
    const local = [...(own?.functions ?? []), ...(own?.classes ?? []).flatMap((c) => c.methods ?? [])]
      .find((f) => f.name === handler);
    if (local) return { fn: local, filePath: route.filePath };
    return uniqueInProject(byName.get(handler), projectId);
  };

  let filled = 0;
  for (const route of routes) {
    if (route.kind !== "api") continue;
    const ref = resolve(route);
    if (!ref) continue;
    // What the handler answers is the route's answer, unless the route states its own.
    if (!route.responses && ref.fn.responses) route.responses = ref.fn.responses;
    const lang = byFile.get(ref.filePath)?.language;
    const hooks = lang ? pluginFor(lang)?.requestSchema : undefined;
    const tokens = pathParamNames(route.path);
    // Merge into whatever the extractor already declared (a multer form
    // field, a path token) rather than replacing or skipping — the handler's
    // reads are additional facts, deduped by binding + name.
    const params: RouteParamInfo[] = [...(route.params ?? [])];
    const seen = new Set(params.map((p) => `${p.binding}:${p.name}`));
    // A signature parameter is one thing however it binds: if the extractor
    // already listed it (under an inferred `services`/`route`), the join must
    // not add a second `binding: null` copy of the same name.
    const seenNames = new Set(params.map((p) => p.name.toLowerCase()));
    const declaredSignature = params.some((p) => p.binding !== null && !p.inferred);
    const before = params.length;
    for (const p of declaredSignature ? [] : ref.fn.params ?? []) {
      // An extension method's receiver is the object it is called on, not a request input.
      if (p.isReceiver || !p.name || p.name === "_" || seenNames.has(p.name.toLowerCase())) continue;
      let binding: RouteParamBinding | null = tokens.has(p.name.toLowerCase()) ? "route" : null;
      if (!binding && hooks?.bindParam) binding = hooks.bindParam(p, route);
      seen.add(`${binding}:${p.name}`);
      seenNames.add(p.name.toLowerCase());
      params.push(binding ? { name: p.name, type: p.type, binding, inferred: true } : { name: p.name, type: p.type, binding: null });
    }
    for (const acc of ref.fn.requestAccess ?? []) {
      // A read the handler could not place (`params[:slug]` is query OR route
      // in Rails) is placed by the route's own template.
      const binding = (acc.binding === null || acc.binding === "query") && tokens.has(acc.name.toLowerCase())
        ? "route"
        : acc.binding;
      const key = `${binding}:${acc.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      params.push({ ...acc, binding, inferred: true });
    }
    // The route's own template is a fact whether or not the handler reads
    // the token (`:id` in Vapor, `<id>` in shelf): list it.
    const covered = new Set(params.filter((p) => p.binding === "route").map((p) => p.name.toLowerCase()));
    for (const token of pathParamTokens(route.path)) {
      const key = token.toLowerCase();
      if (covered.has(key)) continue;
      const declared = (ref.fn.params ?? []).find((p) => p.name.toLowerCase() === key);
      params.push({ name: declared?.name ?? token, type: declared?.type ?? null, binding: "route", inferred: true });
      covered.add(key);
    }
    if (params.length === before) continue;
    route.params = params;
    filled++;
  }
  return filled;
}

/**
 * Attach a `requestSchema` to every api route with a body-bound parameter
 * whose type resolves to a class. Returns how many routes got one.
 */
export function attachRequestSchemas(routes: RouteRow[], analyses: FileAnalysis[]): number {
  const languageOf = new Map<string, FileAnalysis["language"]>();
  const byName = new Map<string, ClassRef[]>();
  for (const a of analyses) {
    languageOf.set(a.filePath, a.language);
    for (const cls of a.classes ?? []) {
      if (cls.kind === "interface") continue;
      const ref = { cls, filePath: a.filePath, projectId: a.projectId ?? "root" };
      // Indexed under the full name and its leaf (`MyApp.Accounts.Address` /
      // `Address`): type texts name either.
      for (const key of new Set([cls.name, leafName(cls.name)])) {
        const refs = byName.get(key) ?? [];
        refs.push(ref);
        byName.set(key, refs);
      }
    }
  }
  let attached = 0;
  for (const route of routes) {
    if (route.kind !== "api") continue;
    const bodyParams = (route.params ?? []).filter((p) => p.binding === "body");
    if (bodyParams.length === 0) continue;
    const lang = languageOf.get(route.filePath);
    const hooks = lang ? pluginFor(lang)?.requestSchema : undefined;
    if (!hooks) continue;
    const builder = new SchemaBuilder(hooks, byName, route.projectId ?? "root");

    // The whole body: a typed parameter whose type is a shape (object/array),
    // not a bare `$ref` the reader already has from `params`.
    let schema: JsonSchemaNode | null = null;
    let unresolvedWhole = false;
    for (const p of bodyParams) {
      if (!p.type) continue;
      const s = builder.schemaFor(p.type, 0);
      if (s.$ref && Object.keys(s).length === 1) {
        // A typed body whose class is unknown here: the body's shape is that
        // class, and a guess from the other params would be wrong.
        unresolvedWhole = true;
        continue;
      }
      if (s.type === "object" || s.type === "array") {
        schema = s;
        break;
      }
    }
    // Only FIELDS of the body are known (`req.body.name`, `validate(['status'
    // => 'required|string'])`, `@Body('name') name: string`): the body is an
    // object with those properties, typed where the field is.
    if (!schema) {
      if (unresolvedWhole) continue;
      const fields = bodyParams.filter((p) => p.name !== "body" && !p.name.includes("["));
      if (fields.length === 0) continue;
      const properties: Record<string, JsonSchemaNode> = {};
      for (const f of fields) {
        const s = f.type ? builder.schemaFor(f.type, 1) : {};
        properties[f.name] = s.$ref && Object.keys(s).length === 1 && !f.type ? {} : s;
      }
      // Only the fields the handler names: the body has at least these.
      schema = { type: "object", properties, additionalProperties: true };
    }
    route.requestSchema = schema;
    attached++;
  }
  return attached;
}

/**
 * Attach a `responseSchema` to every api route whose handler states its
 * success body: the first default or 2xx response with a declared type
 * (flattened like a request body) or literal keys (a closed object of those
 * fields). Returns how many routes got one.
 */
export function attachResponseSchemas(routes: RouteRow[], analyses: FileAnalysis[]): number {
  const languageOf = new Map<string, FileAnalysis["language"]>();
  const byName = new Map<string, ClassRef[]>();
  for (const a of analyses) {
    languageOf.set(a.filePath, a.language);
    for (const cls of a.classes ?? []) {
      if (cls.kind === "interface" && !(cls.properties?.length)) continue;
      const ref = { cls, filePath: a.filePath, projectId: a.projectId ?? "root" };
      for (const key of new Set([cls.name, leafName(cls.name)])) (byName.get(key) ?? byName.set(key, []).get(key)!).push(ref);
    }
  }
  let attached = 0;
  for (const route of routes) {
    if (route.kind !== "api" || !route.responses) continue;
    const ok = route.responses.find((r) => (r.status === null || (r.status >= 200 && r.status < 300)) && (r.type || r.keys));
    if (!ok) continue;
    let schema: JsonSchemaNode | null = null;
    if (ok.keys) {
      schema = { type: "object", properties: Object.fromEntries(ok.keys.map((k) => [k, {}])), additionalProperties: false };
    } else if (ok.type) {
      const lang = languageOf.get(route.filePath);
      const hooks = lang ? pluginFor(lang)?.requestSchema : undefined;
      if (!hooks) continue;
      const s = new SchemaBuilder(hooks, byName, route.projectId ?? "root").schemaFor(ok.type, 0);
      if (s.$ref && Object.keys(s).length === 1) continue;
      schema = s;
    }
    if (!schema) continue;
    route.responseSchema = schema;
    attached++;
  }
  return attached;
}

/**
 * Turns a type as written in a handler signature into a JSON-schema-like node
 * by asking the plugin's `RequestSchemaHooks` what the type is (primitive,
 * array, map, object, …) and flattening object types through their
 * `extends` chain. Classes are looked up by name within the handler's own
 * sub-project first. An unknown type, a type already being inlined (a cycle)
 * or one past `MAX_DEPTH` is emitted as a bare `$ref`; an enum as its member
 * names.
 */
class SchemaBuilder {
  /** Object types currently being inlined, to cut cycles (`Node.Children: List<Node>`). */
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly hooks: RequestSchemaHooks,
    private readonly byName: Map<string, ClassRef[]>,
    private readonly projectId: string,
  ) {}

  schemaFor(typeText: string, depth: number): JsonSchemaNode {
    const { type, nullable } = this.hooks.unwrapNullable(typeText);
    const shape = this.hooks.describeType(type);
    let node: JsonSchemaNode;
    switch (shape.kind) {
      case "scalar":
        node = shape.schema;
        break;
      case "any":
        node = {};
        break;
      case "array":
        node = { type: "array", items: this.schemaFor(shape.element, depth + 1) };
        break;
      case "map":
        node = { type: "object", additionalProperties: this.schemaFor(shape.value, depth + 1) };
        break;
      case "object":
        node = this.objectSchema(shape.name, depth);
        break;
    }
    if (nullable) node.nullable = true;
    return node;
  }

  private objectSchema(name: string, depth: number): JsonSchemaNode {
    const ref = this.resolve(name);
    if (!ref || depth >= MAX_DEPTH || this.inProgress.has(ref.cls.name)) return { $ref: name };
    if (ref.cls.kind === "enum") {
      // A closed set of named values serializes as its member names.
      const members = (ref.cls.properties ?? []).map((p) => p.name);
      return members.length > 0 ? { type: "string", enum: members } : { $ref: name };
    }

    this.inProgress.add(ref.cls.name);
    try {
      const properties: Record<string, JsonSchemaNode> = {};
      const required: string[] = [];
      // Derived class first so its property wins over a same-named base one;
      // the output order is base-first, which is how the class reads.
      const chain = this.inheritanceChain(ref);
      const seen = new Set<string>();
      for (const c of chain) {
        for (const prop of c.cls.properties ?? []) {
          if (seen.has(prop.name)) continue;
          seen.add(prop.name);
          if (!this.hooks.isSerialized(prop)) continue;
          const wire = this.hooks.serializedName(prop);
          properties[wire] = prop.type ? this.schemaFor(prop.type, depth + 1) : {};
          if (this.hooks.isRequired(prop)) required.push(wire);
        }
      }
      const ordered: Record<string, JsonSchemaNode> = {};
      for (const c of [...chain].reverse()) {
        for (const prop of c.cls.properties ?? []) {
          const wire = this.hooks.serializedName(prop);
          if (wire in properties && !(wire in ordered)) ordered[wire] = properties[wire]!;
        }
      }
      const node: JsonSchemaNode = { type: "object", properties: ordered };
      if (required.length > 0) node.required = required.filter((r) => r in ordered);
      if (node.required?.length === 0) delete node.required;
      return node;
    } finally {
      this.inProgress.delete(ref.cls.name);
    }
  }

  /** The class, then its bases (nearest first), up to `MAX_BASES` deep. */
  private inheritanceChain(start: ClassRef): ClassRef[] {
    const chain = [start];
    const visited = new Set([start.cls.name]);
    let cur = start;
    for (let i = 0; i < MAX_BASES; i++) {
      const baseName = cur.cls.extends;
      if (!baseName) break;
      const base = this.resolve(baseName, cur.projectId);
      if (!base || visited.has(base.cls.name)) break;
      visited.add(base.cls.name);
      chain.push(base);
      cur = base;
    }
    return chain;
  }

  /**
   * Class by declared type name: same sub-project first, then the one
   * project-wide definition; several candidates in other projects is a guess
   * we do not make. Generic arguments and namespace qualification are
   * stripped for the lookup (`Api.Models.Foo<Bar>` → `Foo`).
   */
  private resolve(typeName: string, projectId = this.projectId): ClassRef | null {
    const generic = typeName.replace(/<.*$/s, "").trim();
    const refs = this.byName.get(generic) ?? this.byName.get(leafName(generic));
    if (!refs || refs.length === 0) return null;
    const local = refs.filter((r) => r.projectId === projectId);
    if (local.length >= 1) return local[0]!;
    return refs.length === 1 ? refs[0]! : null;
  }
}
