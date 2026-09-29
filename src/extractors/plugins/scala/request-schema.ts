import type { ParamInfo, PropertyInfo, RouteParamInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Scala types and case-class fields look on the wire under Play JSON /
 * circe / Jackson, plus what a Play action body reads from its `request`.
 * Consumed by the language-agnostic request-schema pass and the regex base;
 * nothing here walks classes or routes.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" }, Char: { type: "string" },
  Int: { type: "integer", format: "int32" }, Long: { type: "integer", format: "int64" },
  Short: { type: "integer", format: "int32" }, Byte: { type: "integer", format: "int32" },
  BigInt: { type: "integer" },
  Double: { type: "number", format: "double" }, Float: { type: "number", format: "float" },
  BigDecimal: { type: "number", format: "double" },
  Boolean: { type: "boolean" },
  Instant: { type: "string", format: "date-time" },
  LocalDateTime: { type: "string", format: "date-time" },
  ZonedDateTime: { type: "string", format: "date-time" },
  OffsetDateTime: { type: "string", format: "date-time" },
  Date: { type: "string", format: "date-time" },
  Timestamp: { type: "string", format: "date-time" },
  LocalDate: { type: "string", format: "date" },
  LocalTime: { type: "string", format: "time" },
  Duration: { type: "string", format: "duration" },
  UUID: { type: "string", format: "uuid" },
  URI: { type: "string", format: "uri" },
  URL: { type: "string", format: "uri" },
};

const ANY_TYPES = new Set(["Any", "AnyRef", "AnyVal", "JsValue", "JsObject", "Json", "Object"]);
const ARRAY_GENERICS = new Set(["Seq", "List", "Set", "Vector", "Array", "Iterable", "IndexedSeq", "NonEmptyList", "Chain"]);
const MAP_GENERICS = new Set(["Map", "SortedMap", "ListMap", "HashMap"]);

/** `Foo[A, B[C]]` → `{ name: "Foo", args: ["A", "B[C]"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("[");
  if (lt < 0 || !type.endsWith("]")) return { name: type, args: [] };
  const inner = type.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return { name: type.slice(0, lt), args };
}

/** Drop package qualification (`java.time.Instant` → `Instant`, `scala.collection.immutable.Seq` → `Seq`). */
function simpleName(name: string): string {
  return name.replace(/^(?:[a-z_]\w*\.)+/, "");
}

/** First string argument of an annotation whose name matches: `JsonProperty("x")` → `x`. */
function decoratorString(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w.]+\.)?(\w+)\s*\((.*)\)\s*$/s);
    if (!m || !names.includes(m[1]!)) continue;
    const str = m[2]!.match(/"([^"]*)"/);
    if (str) return str[1]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => {
    const m = d.match(/^(?:[\w.]+\.)?(\w+)(?:\s*\(|$)/);
    return !!m && names.includes(m[1]!);
  });
}

/** Play's request objects, as an action declares them. */
const REQUEST_TYPE_RE = /^(?:play\.api\.mvc\.)?(?:Request|RequestHeader|MessagesRequest|AuthenticatedRequest|SecuredRequest|UserAwareRequest)(?:\[.*\])?$/;

export const scalaRequestSchema: RequestSchemaHooks = {
  /**
   * Play binds every action parameter the routes file does not put in the
   * path from the query string — so, after the join's path-token rule, a
   * request object is injected and anything else is a query value.
   */
  bindParam(param: ParamInfo) {
    if (param.type && REQUEST_TYPE_RE.test(param.type.trim())) return "services";
    return "query";
  },

  unwrapNullable(type) {
    const t = type.trim();
    const g = splitGeneric(t);
    if (simpleName(g.name) === "Option" && g.args.length === 1) return { type: g.args[0]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const g = splitGeneric(t);
    const name = simpleName(g.name);
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
    return decoratorString(prop.decorators, ["JsonProperty", "JsonKey", "JsonName", "SerializedName"]) ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (hasDecorator(prop.decorators, ["JsonIgnore", "transient"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};

// ─── What an action body reads from `request` ──────────────────────────────

/** `val x = ` prefix — the name the decoded value gets. */
const ASSIGN_RE = /^(?:val|var|lazy val)\s+(\w+)\s*(?::\s*[^=]+)?=\s*/;

/**
 * What a Play action body reads from its request — `request.body.validate[T]`,
 * `request.body.as[T]`, `Json.fromJson[T](request.body)`, `request.body.asJson`,
 * `request.getQueryString("q")`, `request.headers.get("X")`. Called by the
 * regex base per function with the body lines; the project-level join copies
 * the result onto the route naming this action.
 */
export function extractScalaRequestAccess(bodyLines: string[], fn: { name: string; params: ParamInfo[] }): RouteParamInfo[] {
  const receivers = new Set(["request", "req"]);
  for (const p of fn.params) {
    if (p.type && REQUEST_TYPE_RE.test(p.type.trim())) receivers.add(p.name);
  }
  const recv = `(?:${[...receivers].join("|")})`;
  const typedBody = new RegExp(`\\b${recv}\\.body\\.(?:validate|as|validateOpt)\\[([^\\]]+(?:\\[[^\\]]*\\])?)\\]`);
  const fromJson = new RegExp(`\\bJson\\.fromJson\\[([^\\]]+(?:\\[[^\\]]*\\])?)\\]\\(\\s*${recv}\\.body`);
  const rawBody = new RegExp(`\\b${recv}\\.body\\.(asJson|asText|asXml|asRaw|asMultipartFormData)\\b`);
  const formBody = new RegExp(`\\b${recv}\\.body\\.asFormUrlEncoded\\b`);
  const query = new RegExp(`\\b${recv}\\.getQueryString\\(\\s*"([^"]+)"`, "g");
  const queryMap = new RegExp(`\\b${recv}\\.queryString\\.get\\(\\s*"([^"]+)"`, "g");
  const header = new RegExp(`\\b${recv}\\.headers\\.(?:get|apply)\\(\\s*"([^"]+)"`, "g");

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
    const typed = line.match(typedBody) ?? line.match(fromJson);
    if (typed) push({ name: assigned ?? "body", type: typed[1]!.trim(), binding: "body" });
    else if (rawBody.test(line)) push({ name: assigned ?? "body", type: null, binding: "body" });
    else if (formBody.test(line)) push({ name: assigned ?? "form", type: null, binding: "form" });
    for (const m of line.matchAll(query)) push({ name: m[1]!, type: null, binding: "query" });
    for (const m of line.matchAll(queryMap)) push({ name: m[1]!, type: null, binding: "query" });
    for (const m of line.matchAll(header)) push({ name: m[1]!, type: null, binding: "header" });
  }
  return out;
}
