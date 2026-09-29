import type { ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";
import { splitTopLevel } from "../shared/regex-base.js";

/**
 * How VB.NET types and properties look on the wire under System.Text.Json /
 * Newtonsoft, plus the attribute-text helpers the route extractor shares
 * (`<Authorize(Roles:="Admin")>` is spelled the same on a class, a method,
 * a parameter and a property). Consumed by the language-agnostic
 * request-schema pass; nothing here walks classes or routes.
 */

// ─── Attributes: `<A, B("x", Name:=y)>` ────────────────────────────────────

/**
 * The attributes of one `<…>` list, each as its own text with whitespace
 * collapsed: `Route("x"), Authorize(Roles:="Admin")` → two strings. The
 * regex base stores an own-line list as a single decorator string, so every
 * reader splits it here before matching names.
 */
export function splitVbAttributes(text: string): string[] {
  return splitTopLevel(text.replace(/^\s*<|>\s*_?\s*$/g, ""))
    .map((a) => a.replace(/\s+/g, " ").trim())
    .filter((a) => a.length > 0);
}

/** Simple name of an attribute: `Web.Http.HttpGet("x")` → `HttpGet`; the `Attribute` suffix is dropped. */
export function vbAttributeName(attr: string): string {
  const m = attr.match(/^(?:[\w.]+\.)?(\w+?)(?:Attribute)?\s*(?:\(|$)/);
  return m ? m[1]! : attr;
}

/** The argument text inside an attribute's parens, or "" when it has none. */
function vbAttributeArgs(attr: string): string {
  const open = attr.indexOf("(");
  if (open < 0) return "";
  const close = attr.lastIndexOf(")");
  return close > open ? attr.slice(open + 1, close) : attr.slice(open + 1);
}

/** Named arguments (`Roles:="Admin"`, `Deprecated:=True`) as name → value with string quotes removed. */
export function vbNamedArgs(attr: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const arg of splitTopLevel(vbAttributeArgs(attr))) {
    const m = arg.trim().match(/^(\w+)\s*:=\s*(.+)$/s);
    if (!m) continue;
    const value = m[2]!.trim();
    const str = value.match(/^"(.*)"$/s);
    out.set(m[1]!, str ? str[1]! : value.replace(/^(?:NameOf|GetType)\((.*)\)$/i, "$1"));
  }
  return out;
}

/** First positional argument of an attribute as text (string unquoted, number verbatim), or null. */
export function vbPositionalArg(attr: string): string | null {
  for (const arg of splitTopLevel(vbAttributeArgs(attr))) {
    const value = arg.trim();
    if (!value || /^\w+\s*:=/.test(value)) continue;
    const str = value.match(/^"(.*)"$/s);
    return str ? str[1]! : value.replace(/[FRDS]$/i, "");
  }
  return null;
}

/** Every decorator of a property/method/class, split into single attributes. */
function attributesOf(decorators: readonly string[] | undefined): string[] {
  return (decorators ?? []).flatMap((d) => splitVbAttributes(d));
}

function hasAttribute(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return attributesOf(decorators).some((a) => names.includes(vbAttributeName(a)));
}

// ─── Types: `List(Of String)`, `Integer?`, `String()` ──────────────────────

/**
 * The type text that starts at `from` in a declaration (`As Foo(Of Bar)`,
 * `As Integer?`, `As String()`), read with balanced parens so a generic
 * argument list survives whole. Returns the text and where it ends.
 */
export function readVbType(text: string, from: number): { type: string; end: number } | null {
  const head = text.slice(from).match(/^\s*([A-Za-z_][\w.]*)/);
  if (!head) return null;
  let end = from + head[0].length;
  let type = head[1]!;
  const generic = text.slice(end).match(/^\s*\(\s*(?:Of\b|\))/i);
  if (generic) {
    const open = end + generic[0].indexOf("(");
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    type += text.slice(open, i + 1).replace(/\s+/g, " ");
    end = i + 1;
  }
  if (text[end] === "?") {
    type += "?";
    end++;
  }
  return { type, end };
}

/** Types ASP.NET binds from a single value (query/route), never from the body. */
const SIMPLE_TYPES = new Set([
  "string", "integer", "long", "short", "byte", "sbyte", "uinteger", "ulong", "ushort",
  "boolean", "double", "single", "decimal", "char", "object", "date", "datetime", "datetimeoffset",
  "dateonly", "timeonly", "timespan", "guid", "uri", "int32", "int64", "int16",
]);

/** Framework-supplied parameters that are never bound from the request. */
export const UNBOUND_TYPES = new Set(["cancellationtoken"]);

/** True for a type ASP.NET binds from the query/route rather than the body. */
export function isSimpleType(type: string | null): boolean {
  if (!type) return true;
  const bare = type.replace(/\?$/, "").replace(/^System\./i, "").toLowerCase();
  if (SIMPLE_TYPES.has(bare)) return true;
  // `Integer()` / `List(Of String)`: arrays of simple values bind from the query.
  const elem = bare.match(/^(?:\w+\(of\s+)?([\w.]+)\)?(?:\(\))?$/)?.[1];
  return elem !== undefined && elem !== bare && SIMPLE_TYPES.has(elem.replace(/^system\./, ""));
}

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" }, char: { type: "string" },
  integer: { type: "integer", format: "int32" }, int32: { type: "integer", format: "int32" },
  uinteger: { type: "integer", format: "int32" }, uint32: { type: "integer", format: "int32" },
  long: { type: "integer", format: "int64" }, int64: { type: "integer", format: "int64" },
  ulong: { type: "integer", format: "int64" }, uint64: { type: "integer", format: "int64" },
  short: { type: "integer", format: "int32" }, int16: { type: "integer", format: "int32" },
  ushort: { type: "integer", format: "int32" }, uint16: { type: "integer", format: "int32" },
  byte: { type: "integer", format: "int32" }, sbyte: { type: "integer", format: "int32" },
  double: { type: "number", format: "double" }, single: { type: "number", format: "float" },
  decimal: { type: "number", format: "double" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date-time" }, datetime: { type: "string", format: "date-time" },
  datetimeoffset: { type: "string", format: "date-time" },
  dateonly: { type: "string", format: "date" }, timeonly: { type: "string", format: "time" },
  timespan: { type: "string", format: "duration" },
  guid: { type: "string", format: "uuid" },
  uri: { type: "string", format: "uri" },
};

const ANY_TYPES = new Set(["object", "dynamic", "jsonelement", "jsonnode", "jobject", "jtoken", "jsondocument"]);
const ARRAY_GENERICS = new Set([
  "list", "ilist", "ienumerable", "icollection", "ireadonlylist", "ireadonlycollection",
  "hashset", "iset", "collection", "observablecollection", "immutablelist", "immutablearray", "queue", "stack",
]);
const MAP_GENERICS = new Set(["dictionary", "idictionary", "ireadonlydictionary", "sorteddictionary", "immutabledictionary"]);

/** `Foo(Of A, B(Of C))` → `{ name: "Foo", args: ["A", "B(Of C)"] }`; `String()` → `{ name: "String", array: true }`. */
function splitGeneric(type: string): { name: string; args: string[]; array: boolean } {
  const t = type.trim();
  if (/\(\s*\)$/.test(t)) return { name: t.replace(/\(\s*\)$/, "").trim(), args: [], array: true };
  const m = t.match(/^([\w.]+)\s*\(\s*Of\s+(.*)\)$/is);
  if (!m) return { name: t, args: [], array: false };
  return { name: m[1]!, args: splitTopLevel(m[2]!).map((a) => a.trim()), array: false };
}

/** Drop namespace qualification on the outer name only (`System.Collections.Generic.List` → `List`). */
function simpleName(name: string): string {
  return name.replace(/^Global\./i, "").replace(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\./, "");
}

/**
 * System.Text.Json's CamelCase policy: lower-case the leading run of upper-case
 * letters, but leave the last of the run when it starts the next word —
 * `Name` → `name`, `ID` → `id`, `URLValue` → `urlValue`.
 */
export function camelCase(name: string): string {
  if (!name || name[0]! < "A" || name[0]! > "Z") return name;
  let run = 0;
  while (run < name.length && name[run]! >= "A" && name[run]! <= "Z") run++;
  if (run === name.length) return name.toLowerCase();
  if (run === 1) return name[0]!.toLowerCase() + name.slice(1);
  const next = name[run]!;
  const isLower = next >= "a" && next <= "z";
  const cut = isLower ? run - 1 : run;
  return name.slice(0, cut).toLowerCase() + name.slice(cut);
}

export const vbRequestSchema: RequestSchemaHooks = {
  /**
   * ASP.NET's default: a simple type binds from the query, a complex one from
   * the body, and a `CancellationToken` is injected. Mirrors what the route
   * extractor infers for un-attributed parameters, so the project-level join
   * dedupes against it instead of adding an unbound twin.
   */
  bindParam(param: ParamInfo) {
    if (param.type && UNBOUND_TYPES.has(param.type.toLowerCase())) return "services";
    return isSimpleType(param.type) ? "query" : "body";
  },

  unwrapNullable(type) {
    const t = type.trim();
    if (t.endsWith("?")) return { type: t.slice(0, -1).trim(), nullable: true };
    const g = splitGeneric(t);
    if (!g.array && simpleName(g.name).toLowerCase() === "nullable" && g.args.length === 1) return { type: g.args[0]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const g = splitGeneric(t);
    if (g.array) return { kind: "array", element: g.name };
    const name = simpleName(g.name).toLowerCase();
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
    for (const attr of attributesOf(prop.decorators)) {
      const name = vbAttributeName(attr);
      if (name === "JsonPropertyName" || name === "JsonProperty") {
        const value = vbPositionalArg(attr) ?? vbNamedArgs(attr).get("PropertyName");
        if (value) return value;
      } else if (name === "DataMember") {
        const value = vbNamedArgs(attr).get("Name");
        if (value) return value;
      }
    }
    return camelCase(prop.name);
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (prop.visibility !== "public") return false;
    if (hasAttribute(prop.decorators, ["JsonIgnore", "IgnoreDataMember", "NotMapped", "ScriptIgnore"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true || hasAttribute(prop.decorators, ["Required", "JsonRequired"]);
  },
};
