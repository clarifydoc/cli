import type { ParamInfo, PropertyInfo, RouteParamInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Swift types and properties look on the wire under `Codable` (Vapor's
 * `Content`), plus what a Vapor handler body reads from its `Request`.
 * Consumed by the language-agnostic request-schema pass and the regex base;
 * nothing here walks classes or routes.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" }, Character: { type: "string" }, Substring: { type: "string" },
  Int: { type: "integer", format: "int64" }, Int8: { type: "integer", format: "int32" },
  Int16: { type: "integer", format: "int32" }, Int32: { type: "integer", format: "int32" },
  Int64: { type: "integer", format: "int64" }, UInt: { type: "integer", format: "int64" },
  UInt8: { type: "integer", format: "int32" }, UInt16: { type: "integer", format: "int32" },
  UInt32: { type: "integer", format: "int32" }, UInt64: { type: "integer", format: "int64" },
  Double: { type: "number", format: "double" }, Float: { type: "number", format: "float" },
  Decimal: { type: "number", format: "double" },
  Bool: { type: "boolean" },
  Date: { type: "string", format: "date-time" },
  UUID: { type: "string", format: "uuid" },
  URL: { type: "string", format: "uri" },
  Data: { type: "string", format: "byte" },
};

const ANY_TYPES = new Set(["Any", "AnyObject", "AnyCodable", "JSON"]);

/** `Foo<A, B<C>>` → `{ name: "Foo", args: ["A", "B<C>"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  return { name: type.slice(0, lt), args: splitTop(type.slice(lt + 1, -1), ",") };
}

/** Split on `sep` outside `<>`/`[]`/`()`. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** First string argument of a decorator whose name matches: `Field(key: "x")` → `x`. */
function decoratorString(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(\w+)\s*\((.*)\)\s*$/s);
    if (!m || !names.includes(m[1]!)) continue;
    const str = m[2]!.match(/"([^"]*)"/);
    if (str) return str[1]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => names.includes(d.replace(/\(.*$/s, "").trim()));
}

/** Vapor's request object, as a handler declares it. */
const REQUEST_TYPES = new Set(["Request", "Vapor.Request"]);

export const swiftRequestSchema: RequestSchemaHooks = {
  bindParam(param: ParamInfo) {
    const type = param.type?.replace(/^inout\s+/, "").trim();
    return type && REQUEST_TYPES.has(type) ? "services" : null;
  },

  unwrapNullable(type) {
    const t = type.trim();
    if (t.endsWith("?") || t.endsWith("!")) return { type: t.slice(0, -1).trim(), nullable: true };
    const g = splitGeneric(t);
    if (g.name === "Optional" && g.args.length === 1) return { type: g.args[0]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    // `[T]` / `[K: V]` — the sugar Swift code actually uses.
    if (t.startsWith("[") && t.endsWith("]")) {
      const inner = t.slice(1, -1);
      const kv = splitTop(inner, ":");
      if (kv.length === 2) return { kind: "map", value: kv[1]! };
      return { kind: "array", element: inner.trim() };
    }
    const g = splitGeneric(t);
    const name = g.name.replace(/^(?:Swift|Foundation)\./, "");
    if (g.args.length === 1 && (name === "Array" || name === "Set")) return { kind: "array", element: g.args[0]! };
    if (g.args.length === 2 && name === "Dictionary") return { kind: "map", value: g.args[1]! };
    if (g.args.length === 0) {
      const scalar = SCALARS[name];
      if (scalar) return { kind: "scalar", schema: { ...scalar } };
      if (ANY_TYPES.has(name)) return { kind: "any" };
    }
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    return decoratorString(prop.decorators, ["Field", "OptionalField", "Enum", "OptionalEnum", "Timestamp", "Group"]) ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    // Fluent relations are loaded, never decoded from a request body. A
    // `@Parent` stays: it is encoded as `{ "id": … }` and is an object here.
    if (hasDecorator(prop.decorators, ["Children", "Siblings", "OptionalChild"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};

// ─── What a handler body reads from `req` ──────────────────────────────────

/** `let x = ` prefix on a statement — the name the decoded value gets. */
const ASSIGN_RE = /(?:let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*(?:try\s+)?(?:await\s+)?/;

/**
 * What a Vapor handler body reads from its request — `req.content.decode`,
 * `req.query[…]`, `req.parameters.get`, `req.headers`, `req.auth`. Called by
 * the regex base per function with the body lines; the project-level join
 * copies the result onto the route whose `use:` names this handler.
 */
export function extractSwiftRequestAccess(bodyLines: string[], fn: { name: string; params: ParamInfo[] }): RouteParamInfo[] {
  const receivers = new Set(["req", "request"]);
  for (const p of fn.params) {
    if (p.type && REQUEST_TYPES.has(p.type.replace(/^inout\s+/, "").trim())) receivers.add(p.name);
  }
  const recv = `(?:${[...receivers].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
  const content = new RegExp(`\\b${recv}\\.content\\.decode\\(\\s*([\\w.]+)\\.self`);
  const queryDecode = new RegExp(`\\b${recv}\\.query\\.decode\\(\\s*([\\w.]+)\\.self`);
  const querySubscript = new RegExp(`\\b${recv}\\.query\\[\\s*(?:([\\w.]+)\\.self\\s*,\\s*at:\\s*)?"([^"]+)"`, "g");
  const queryGet = new RegExp(`\\b${recv}\\.query\\.get\\(\\s*(?:([\\w.]+)\\.self\\s*,\\s*)?at:\\s*"([^"]+)"`, "g");
  const parameters = new RegExp(`\\b${recv}\\.parameters\\.(?:get|require)\\(\\s*"([^"]+)"(?:\\s*,\\s*as:\\s*([\\w.]+)\\.self)?`, "g");
  const headerSubscript = new RegExp(`\\b${recv}\\.headers\\[\\s*(?:"([^"]+)"|\\.(\\w+))`, "g");
  const headerFirst = new RegExp(`\\b${recv}\\.headers\\.first\\(\\s*name:\\s*(?:"([^"]+)"|\\.(\\w+))`, "g");
  const headerAuth = new RegExp(`\\b${recv}\\.headers\\.(bearerAuthorization|basicAuthorization)\\b`);
  const auth = new RegExp(`\\b${recv}\\.auth\\.(?:require|get)\\(\\s*([\\w.]+)\\.self`);

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

    const c = line.match(content);
    if (c) push({ name: assigned ?? "body", type: c[1]!, binding: "body" });
    const qd = line.match(queryDecode);
    if (qd) push({ name: assigned ?? "query", type: qd[1]!, binding: "query" });
    for (const m of line.matchAll(querySubscript)) push({ name: m[2]!, type: m[1] ?? null, binding: "query" });
    for (const m of line.matchAll(queryGet)) push({ name: m[2]!, type: m[1] ?? null, binding: "query" });
    for (const m of line.matchAll(parameters)) push({ name: m[1]!, type: m[2] ?? null, binding: "route" });
    for (const m of line.matchAll(headerSubscript)) push({ name: m[1] ?? m[2]!, type: null, binding: "header" });
    for (const m of line.matchAll(headerFirst)) push({ name: m[1] ?? m[2]!, type: null, binding: "header" });
    if (headerAuth.test(line)) push({ name: "Authorization", type: null, binding: "header" });
    const a = line.match(auth);
    if (a) push({ name: "auth", type: a[1]!, binding: "services" });
  }
  return out;
}
