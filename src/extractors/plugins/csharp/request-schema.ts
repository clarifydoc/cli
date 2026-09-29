import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How C# types and properties look on the wire under System.Text.Json (the
 * ASP.NET Core default) — and Newtonsoft where the attribute is unambiguous.
 * Consumed by the language-agnostic request-schema pass; nothing here walks
 * classes or routes.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" }, String: { type: "string" }, char: { type: "string" }, Char: { type: "string" },
  int: { type: "integer", format: "int32" }, Int32: { type: "integer", format: "int32" },
  uint: { type: "integer", format: "int32" }, UInt32: { type: "integer", format: "int32" },
  long: { type: "integer", format: "int64" }, Int64: { type: "integer", format: "int64" },
  ulong: { type: "integer", format: "int64" }, UInt64: { type: "integer", format: "int64" },
  short: { type: "integer", format: "int32" }, Int16: { type: "integer", format: "int32" },
  ushort: { type: "integer", format: "int32" }, UInt16: { type: "integer", format: "int32" },
  byte: { type: "integer", format: "int32" }, Byte: { type: "integer", format: "int32" },
  sbyte: { type: "integer", format: "int32" }, SByte: { type: "integer", format: "int32" },
  double: { type: "number", format: "double" }, Double: { type: "number", format: "double" },
  float: { type: "number", format: "float" }, Single: { type: "number", format: "float" },
  decimal: { type: "number", format: "double" }, Decimal: { type: "number", format: "double" },
  bool: { type: "boolean" }, Boolean: { type: "boolean" },
  DateTime: { type: "string", format: "date-time" },
  DateTimeOffset: { type: "string", format: "date-time" },
  DateOnly: { type: "string", format: "date" },
  TimeOnly: { type: "string", format: "time" },
  TimeSpan: { type: "string", format: "duration" },
  Guid: { type: "string", format: "uuid" },
  Uri: { type: "string", format: "uri" },
};

const ANY_TYPES = new Set(["object", "Object", "dynamic", "JsonElement", "JsonNode", "JObject", "JToken", "JsonDocument"]);

const ARRAY_GENERICS = new Set([
  "List", "IList", "IEnumerable", "ICollection", "IReadOnlyList", "IReadOnlyCollection",
  "HashSet", "ISet", "Collection", "ObservableCollection", "ImmutableList", "ImmutableArray", "Queue", "Stack",
]);
const MAP_GENERICS = new Set(["Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary", "ImmutableDictionary"]);

/** `Foo<A, B<C>>` → `{ name: "Foo", args: ["A", "B<C>"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  const name = type.slice(0, lt);
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
  return { name, args };
}

/** Drop namespace qualification (`System.Collections.Generic.List` → `List`) on the outer name only. */
function simpleName(name: string): string {
  return name.replace(/^global::/, "").replace(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\./, "");
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

/** First string argument of a decorator whose name matches: `JsonPropertyName("x")` → `x`. */
function decoratorString(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w.]+\.)?(\w+)(?:Attribute)?\s*\((.*)\)\s*$/s);
    if (!m || !names.includes(m[1]!)) continue;
    const str = m[2]!.match(/"([^"]*)"/);
    if (str) return str[1]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => {
    const m = d.match(/^(?:[\w.]+\.)?(\w+)(?:Attribute)?(?:\s*\(|$)/);
    return !!m && names.includes(m[1]!);
  });
}

export const csharpRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    const t = type.trim();
    if (t.endsWith("?")) return { type: t.slice(0, -1).trim(), nullable: true };
    const g = splitGeneric(t);
    if (simpleName(g.name) === "Nullable" && g.args.length === 1) return { type: g.args[0]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
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
    return (
      decoratorString(prop.decorators, ["JsonPropertyName", "JsonProperty", "DataMember"]) ??
      camelCase(prop.name)
    );
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (prop.visibility !== "public") return false;
    if (hasDecorator(prop.decorators, ["JsonIgnore", "IgnoreDataMember", "NotMapped"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true || hasDecorator(prop.decorators, ["Required", "JsonRequired"]);
  },
};
