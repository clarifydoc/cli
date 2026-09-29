import type { ParamInfo, PropertyInfo, RouteParamInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";
import type { GuardAttr } from "../../shared/route-metadata.js";

/**
 * How Dart types and fields look on the wire under `json_serializable` /
 * hand-written `fromJson`, what a shelf handler reads from its `Request`, and
 * what a `Pipeline().addMiddleware(...)` chain guards. Consumed by the
 * language-agnostic request-schema pass and the regex base; nothing here
 * walks classes or routes.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" },
  int: { type: "integer", format: "int64" },
  double: { type: "number", format: "double" },
  num: { type: "number" },
  bool: { type: "boolean" },
  DateTime: { type: "string", format: "date-time" },
  Duration: { type: "string", format: "duration" },
  Uri: { type: "string", format: "uri" },
  BigInt: { type: "integer" },
};

const ANY_TYPES = new Set(["dynamic", "Object", "Map", "List"]);
const ARRAY_GENERICS = new Set(["List", "Set", "Iterable", "BuiltList", "IList"]);
const MAP_GENERICS = new Set(["Map", "BuiltMap", "IMap"]);

/** `Foo<A, B<C>>` → `{ name: "Foo", args: ["A", "B<C>"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  const inner = type.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return { name: type.slice(0, lt), args };
}

/** Named argument of a decorator: `JsonKey(name: 'x', ignore: true)` → `name` → `'x'`. */
function decoratorArg(decorators: readonly string[] | undefined, decorator: string, arg: string): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(\w+)\s*\((.*)\)\s*$/s);
    if (!m || m[1] !== decorator) continue;
    const v = m[2]!.match(new RegExp(`(?:^|,)\\s*${arg}\\s*:\\s*([^,]+)`));
    if (v) return v[1]!.trim();
  }
  return null;
}

/** Framework-injected handler parameters (shelf `Request`, dart_frog `RequestContext`). */
const REQUEST_TYPES = new Set(["Request", "RequestContext", "HttpRequest"]);

export const dartRequestSchema: RequestSchemaHooks = {
  bindParam(param: ParamInfo) {
    return param.type && REQUEST_TYPES.has(param.type.trim()) ? "services" : null;
  },

  unwrapNullable(type) {
    const t = type.trim();
    if (t.endsWith("?")) return { type: t.slice(0, -1).trim(), nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const g = splitGeneric(t);
    const name = g.name.replace(/^[a-z_]\w*\./, ""); // `prefix.Type` import alias
    if (g.args.length === 1 && ARRAY_GENERICS.has(name)) return { kind: "array", element: g.args[0]! };
    if (g.args.length === 2 && MAP_GENERICS.has(name)) return { kind: "map", value: g.args[1]! };
    if (g.args.length === 0) {
      const scalar = SCALARS[name];
      if (scalar) return { kind: "scalar", schema: { ...scalar } };
      if (ANY_TYPES.has(name)) return { kind: "any" };
    }
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    const named = decoratorArg(prop.decorators, "JsonKey", "name");
    const str = named?.match(/^['"](.*)['"]$/);
    return str ? str[1]! : prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (prop.name.startsWith("_")) return false;
    if (decoratorArg(prop.decorators, "JsonKey", "ignore") === "true") return false;
    if (decoratorArg(prop.decorators, "JsonKey", "includeFromJson") === "false") return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};

// ─── What a shelf handler body reads from `request` ─────────────────────────

/** `final x = ` / `var x = ` / `Type x = ` prefix — the name the decoded value gets. */
const ASSIGN_RE = /^(?:final|var|const|late)?\s*(?:[A-Z]\w*(?:<[^=]*>)?\??\s+)?(\w+)\s*=\s*(?:await\s+)?/;

/**
 * What a shelf handler body reads from its request — `request.readAsString()`
 * (raw or `T.fromJson(jsonDecode(...))`), `request.url.queryParameters['q']`,
 * `request.headers['x']`, `request.params['id']`. Called by the regex base
 * per function with the body lines; the project-level join copies the result
 * onto the route naming this handler.
 */
export function extractDartRequestAccess(bodyLines: string[], fn: { name: string; params: ParamInfo[] }): RouteParamInfo[] {
  const receivers = new Set(["request", "req"]);
  for (const p of fn.params) {
    if (p.type && REQUEST_TYPES.has(p.type.trim())) receivers.add(p.name);
  }
  const recv = `(?:${[...receivers].join("|")})`;
  const bodyRead = new RegExp(`\\b${recv}\\.(?:readAsString|read)\\(\\)`);
  const typedBody = new RegExp(`\\b([A-Z]\\w*)\\.fromJson\\(\\s*(?:jsonDecode|json\\.decode)\\(\\s*await\\s+${recv}\\.readAsString\\(\\)`);
  const query = new RegExp(`\\b${recv}\\.(?:url|requestedUri)\\.queryParameters(?:All)?\\[\\s*['"]([^'"]+)['"]`, "g");
  const header = new RegExp(`\\b${recv}\\.headers\\[\\s*['"]([^'"]+)['"]`, "g");
  const routeParam = new RegExp(`\\b${recv}\\.params\\[\\s*['"]([^'"]+)['"]`, "g");

  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const push = (p: RouteParamInfo) => {
    const key = `${p.binding}:${p.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line.startsWith("//")) continue;
    const assigned = line.match(ASSIGN_RE)?.[1] ?? null;
    const typed = line.match(typedBody);
    if (typed) push({ name: assigned ?? "body", type: typed[1]!, binding: "body" });
    else if (bodyRead.test(line)) push({ name: assigned ?? "body", type: null, binding: "body" });
    for (const m of line.matchAll(query)) push({ name: m[1]!, type: null, binding: "query" });
    for (const m of line.matchAll(header)) push({ name: m[1]!, type: null, binding: "header" });
    for (const m of line.matchAll(routeParam)) push({ name: m[1]!, type: null, binding: "route" });
  }
  return out;
}

// ─── Pipeline middleware → guards ──────────────────────────────────────────

/** A middleware whose name says it authenticates or authorises. */
const AUTH_MIDDLEWARE_RE = /auth|jwt|token|session|guard/i;
/** …and one that names a mechanism rather than a check. */
const SCHEME_RE = /jwt|basic|bearer|token|session/i;

/** One `addMiddleware(...)` argument → what it contributes to the route, or null for plain middleware. */
export function middlewareGuard(expr: string): GuardAttr | null {
  const text = expr.replace(/\s+/g, " ").trim();
  if (!AUTH_MIDDLEWARE_RE.test(text)) return null;
  const name = text.replace(/\(.*$/s, "");
  return SCHEME_RE.test(name)
    ? { text, anonymous: false, policies: [], roles: [], schemes: [name] }
    : { text, anonymous: false, policies: [name], roles: [], schemes: [] };
}
