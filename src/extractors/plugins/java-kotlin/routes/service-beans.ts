import type { ClassInfo, FileAnalysis, FunctionInfo, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { CXF_SERVICE_BEANS_FACT, type ServiceBeanFact } from "../../shared/cxf-service-beans.js";

/**
 * Apache CXF service beans: the classes a `JAXRSServerFactoryBean` (or a Spring
 * XML `<jaxrs:server>`) serves.
 *
 *   @Bean Server rsServer(MatchApi matchApi, ClubApi clubApi) {
 *     JAXRSServerFactoryBean endpoint = new JAXRSServerFactoryBean();
 *     endpoint.setServiceBeans(List.of(matchApi, clubApi));
 *
 * The resource interfaces are usually generated from an API spec into a jar
 * (`com.example.league.api.MatchApi`), so their `@Path`/`@GET` annotations are
 * not in the analysis and the implementing class (`MatchApiImpl implements
 * MatchApi`) carries none. What IS stated in the source is which interface each
 * served method implements. Each such method becomes an API row whose
 * `contract` is that operation (`com.example.league.api.MatchApi#getMatch`) —
 * the identity a client proxy of the same interface calls — anchored on the
 * implementing method, so it reaches its data. Its URL is in the jar: the row's
 * `path` names the operation and `prefixUnresolved` says why, and the path
 * tiers of the route linker never match it.
 */


const GATE = /\.setServiceBean(?:s|Objects)?\s*\(|RealmResourceProvider\b/;
const REGISTER_RE = /\.setServiceBean(?:s|Objects)?\s*\(/g;
/** Collection wrappers whose arguments are the beans themselves. */
const WRAPPERS = /^(?:(?:java\.util\.)?(?:Arrays\.asList|List\.of|Set\.of|Collections\.singletonList)|asList|listOf|setOf|mutableListOf|arrayListOf)$/;
const OBJECT_TYPES = new Set(["Object", "Any", "Any?"]);

/**
 * The text with comments and string contents blanked, offsets kept — one pass,
 * so `"/*"` in a string opens no comment.
 */
function blank(text: string): string {
  const out = text.split("");
  let i = 0;
  const wipe = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      wipe(i, stop);
      i = stop;
    } else if (text[i] === '"' || text[i] === "'") {
      const q = text.startsWith('"""', i) ? '"""' : text[i]!;
      let j = i + q.length;
      while (j < text.length && !text.startsWith(q, j) && (q === '"""' || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      wipe(i + q.length, j);
      i = j + q.length;
    } else i++;
  }
  return out.join("");
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function argsAt(text: string, open: number): string[] | null {
  let depth = 0;
  let start = open + 1;
  const out: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last) out.push(last);
        return out;
      }
    } else if (c === "," && depth === 1) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** The method declaration a varargs parameter `Object... name` belongs to: its name and the parameter's index. */
function varargsOwner(text: string, param: string): { method: string; index: number } | null {
  const re = new RegExp(`\\b(\\w+)\\s*\\(([^()]*\\b(?:Object|Any)\\s*(?:\\.\\.\\.|\\[\\])\\s*${param}\\b[^()]*)\\)\\s*(?:throws[^{]*)?\\{`, "g");
  const kt = new RegExp(`\\bfun\\s+(\\w+)\\s*\\(([^()]*\\bvararg\\s+${param}\\s*:\\s*Any\\??[^()]*)\\)`, "g");
  const m = re.exec(text) ?? kt.exec(text);
  if (!m) return null;
  const params = m[2]!.split(",").map((p) => p.trim());
  const index = params.findIndex((p) => new RegExp(`\\b${param}\\b`).test(p));
  return index >= 0 ? { method: m[1]!, index } : null;
}

/** The declared type of `name` in the file: a field, parameter or local (`MatchApi matchApi`, `matchApi: MatchApi`). */
function declaredType(text: string, name: string): string | null {
  const java = new RegExp(`\\b([A-Z]\\w*(?:\\.\\w+)*)(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(\\s*\\.\\.\\.|\\s*\\[\\])?\\s+${name}\\s*[;,)=:]`);
  const kotlin = new RegExp(`\\b${name}\\s*:\\s*([A-Z]\\w*(?:\\.\\w+)*\\??)`);
  const m = java.exec(text);
  if (m) return m[2] ? "Object" : m[1]!;
  return kotlin.exec(text)?.[1] ?? null;
}

/** The registered beans' types for one argument expression; `seen` stops a wrapper that calls itself. */
function typesOf(text: string, arg: string, seen: Set<string>, out: Set<string>): void {
  const expr = arg.replace(/^this\./, "").trim();
  const created = /^new\s+([A-Z][\w.]*)/.exec(expr);
  if (created) {
    out.add(created[1]!);
    return;
  }
  const call = /^([\w.]+)\s*\(/.exec(expr);
  if (call) {
    if (!WRAPPERS.test(call[1]!)) return;
    for (const a of argsAt(expr, expr.indexOf("(")) ?? []) typesOf(text, a, seen, out);
    return;
  }
  if (!/^\w+$/.test(expr)) return;
  const type = declaredType(text, expr);
  if (type && !OBJECT_TYPES.has(type)) {
    out.add(type.replace(/\?$/, ""));
    return;
  }
  // `Object... serviceBeans` handed on: the beans are what the file's calls of that method pass there.
  const owner = varargsOwner(text, expr);
  if (!owner || seen.has(owner.method)) return;
  seen.add(owner.method);
  const callRe = new RegExp(`\\b${owner.method}\\s*\\(`, "g");
  for (const m of text.matchAll(callRe)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    // The declaration itself, not a call of it.
    if (/(?:\bfun|\b[\w>\]]+)\s+$/.test(before) && !/\breturn\s+$|=\s*$|\(\s*$|,\s*$/.test(before)) continue;
    const args = argsAt(text, m.index + m[0].length - 1);
    for (const a of args?.slice(owner.index) ?? []) typesOf(text, a, seen, out);
  }
}

/** Per-file: the types this file registers as CXF service beans (or a Keycloak realm resource), as a route fact. */
export function collectServiceBeans(sourceText: string, facts: RouteFact[] | undefined): void {
  if (!facts || !GATE.test(sourceText)) return;
  const text = blank(sourceText);
  const types = new Set<string>();
  let line = 0;
  for (const m of text.matchAll(REGISTER_RE)) {
    line ||= text.slice(0, m.index).split("\n").length;
    for (const a of argsAt(text, m.index + m[0].length - 1) ?? []) typesOf(text, a, new Set(), types);
  }
  // Keycloak: a realm resource provider hands out the JAX-RS resource it serves.
  if (/\bimplements\s+[\w.,\s]*RealmResourceProvider\b/.test(text)) {
    const get = /\bgetResource\s*\(/.exec(text);
    const created = get ? /\breturn\s+new\s+([A-Z]\w*(?:\.\w+)*)/.exec(text.slice(get.index)) : null;
    if (created) {
      types.add(created[1]!);
      line ||= text.slice(0, get!.index).split("\n").length;
    }
  }
  if (types.size === 0) return;
  // Qualify each type the way the file names it: an import, else the file's own package.
  const pkg = /^\s*package\s+([\w.]+)/m.exec(text)?.[1];
  const qualified = [...types].map((t) => {
    if (t.includes(".")) return t;
    const imp = new RegExp(`^\\s*import\\s+([\\w.]+\\.${t})\\s*;?\\s*$`, "m").exec(text)?.[1];
    return imp ?? (pkg ? `${pkg}.${t}` : t);
  });
  facts.push({ kind: CXF_SERVICE_BEANS_FACT, line, data: { types: qualified.sort() } satisfies ServiceBeanFact });
}

const simple = (t: string): string => t.replace(/<.*$/, "").replace(/^.*\./, "");
/** Methods every class has: an `@Override` of one is not an API operation. */
const OBJECT_METHODS = new Set(["toString", "equals", "hashCode", "clone", "finalize", "close"]);

/**
 * The served methods of a class implementing the API interface: its `@Override`s
 * (Kotlin states `override` as a modifier, so a class with no annotation at all
 * offers every public method), never one the class overrides from a project
 * superclass.
 */
function servedMethods(cls: ClassInfo, inherited: ReadonlySet<string>): FunctionInfo[] {
  const methods = cls.methods.filter((m) => m.isExported && m.name !== cls.name && m.name !== "constructor" && !OBJECT_METHODS.has(m.name));
  const marked = methods.filter((m) => m.decorators.some((d) => /^(?:java\.lang\.)?Override\b/.test(d)));
  const anyMarked = cls.methods.some((m) => m.decorators.some((d) => /^(?:java\.lang\.)?Override\b/.test(d)));
  return (anyMarked ? marked : methods).filter((m) => !inherited.has(m.name));
}

/** What the resolver knows of the project: registered types, JVM classes by name, APIs already described. */
interface BeanIndex {
  /** Registered type, simple name → as the registering file qualifies it. */
  registered: Map<string, string>;
  classes: Map<string, Array<{ cls: ClassInfo; file: FileAnalysis }>>;
  /** Contract types some row already carries — an interface declared here, or a spec's. */
  described: Set<string>;
}

const isJvm = (a: FileAnalysis): boolean => a.language === "java" || a.language === "kotlin";

function indexBeans(analyses: FileAnalysis[]): BeanIndex | null {
  const registered = new Map<string, string>();
  for (const f of analyses.flatMap((a) => a.routeFacts ?? [])) {
    if (f.kind !== CXF_SERVICE_BEANS_FACT) continue;
    for (const t of (f.data as ServiceBeanFact).types) if (!registered.has(simple(t))) registered.set(simple(t), t);
  }
  if (registered.size === 0) return null;
  const classes = new Map<string, Array<{ cls: ClassInfo; file: FileAnalysis }>>();
  for (const a of analyses.filter(isJvm)) {
    for (const cls of a.classes) (classes.get(cls.name) ?? classes.set(cls.name, []).get(cls.name)!).push({ cls, file: a });
  }
  const described = new Set(analyses.flatMap((a) => a.routes.flatMap((r) => (r.contract ? [simple(r.contract.type)] : []))));
  return { registered, classes, described };
}

/** The jar interfaces a class implements, directly or through project interfaces (whose own methods are routed here). */
function implementedApis(cls: ClassInfo, idx: BeanIndex): { apis: Set<string>; declared: Set<string>; viaRegistered: boolean } {
  const out = { apis: new Set<string>(), declared: new Set<string>(), viaRegistered: idx.registered.has(cls.name) };
  const seen = new Set<string>();
  const queue = cls.implements.map(simple);
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    if (idx.registered.has(t)) out.viaRegistered = true;
    const decls = idx.classes.get(t);
    if (!decls) {
      if (!idx.described.has(t)) out.apis.add(t);
      continue;
    }
    for (const { cls: iface } of decls.filter((d) => d.cls.kind === "interface")) {
      for (const m of iface.methods) out.declared.add(m.name);
      queue.push(...[iface.extends ?? "", ...iface.implements].filter(Boolean).map(simple));
    }
  }
  return out;
}

/**
 * The interface a registered bean serves: a registered jar interface names
 * itself; a bean registered by its class (or a project interface) serves the
 * one jar interface it implements.
 */
function contractOf(cls: ClassInfo, file: FileAnalysis, idx: BeanIndex): { type: string; declared: Set<string> } | null {
  const { apis, declared, viaRegistered } = implementedApis(cls, idx);
  const named = [...apis].filter((i) => idx.registered.has(i));
  let served = named;
  if (named.length === 0 && viaRegistered) served = [...apis];
  if (served.length !== 1) return null;
  const api = served[0]!;
  return { type: idx.registered.get(api) ?? importedName(api, file), declared };
}

/** Methods a class inherits from project superclasses: overriding one is not serving the API. */
function inheritedMethods(cls: ClassInfo, idx: BeanIndex): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  let base = cls.extends ? simple(cls.extends) : null;
  while (base && !seen.has(base)) {
    seen.add(base);
    const decl = idx.classes.get(base);
    if (decl?.length !== 1) break;
    for (const m of decl[0]!.cls.methods) out.add(m.name);
    base = decl[0]!.cls.extends ? simple(decl[0]!.cls.extends) : null;
  }
  return out;
}

/** One row per served method of `cls`, the operation named by its contract. */
function contractRows(cls: ClassInfo, file: FileAnalysis, idx: BeanIndex): RouteInfo[] {
  if (cls.kind === "interface" || cls.kind === "enum") return [];
  const served = contractOf(cls, file, idx);
  if (!served) return [];
  const skip = new Set([...inheritedMethods(cls, idx), ...served.declared]);
  return servedMethods(cls, skip).map((m) => ({
    path: `${simple(served.type)}#${m.name}`,
    httpMethod: null,
    kind: "api",
    handler: m.name,
    owner: cls.name,
    contract: { type: served.type, method: m.name },
    prefixUnresolved: `contract:${served.type}`,
    calls: [],
    middleware: [],
    line: m.line,
  }));
}

export const cxfServiceBeanResolver: RouteResolver = {
  id: "cxf-service-beans",
  // The spec formats too: an API one of them already describes has its rows.
  languages: ["java", "kotlin", "springxml", "openapi", "jsight", "wsdl", "protobuf"],
  priority: 41,
  resolve(analyses: FileAnalysis[]): void {
    const idx = indexBeans(analyses);
    if (!idx) return;
    for (const a of analyses.filter(isJvm)) {
      const added = a.classes.flatMap((cls) => contractRows(cls, a, idx));
      if (added.length > 0) a.routes = [...a.routes, ...added];
    }
  },
};

/** `MatchApi` as the declaring file imports it (`com.example.league.api.MatchApi`), else as written. */
function importedName(name: string, file: FileAnalysis | undefined): string {
  for (const imp of file?.imports ?? []) {
    if (imp.source.endsWith(`.${name}`)) return imp.source;
    if (imp.specifiers.includes(name) && /^[\w.]+$/.test(imp.source)) return `${imp.source}.${name}`;
  }
  return name;
}
