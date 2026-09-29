import type { ParamInfo, PropertyInfo, RouteInfo, RouteParamBinding } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Python type annotations and Pydantic fields look on the wire — what the
 * language-agnostic request-schema pass asks a plugin. Nothing here walks
 * classes or routes; it only reads type text and one property at a time.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  str: { type: "string" },
  int: { type: "integer" },
  float: { type: "number" },
  bool: { type: "boolean" },
  bytes: { type: "string", format: "byte" },
  datetime: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  time: { type: "string", format: "time" },
  timedelta: { type: "string", format: "duration" },
  UUID: { type: "string", format: "uuid" },
  Decimal: { type: "number" },
  EmailStr: { type: "string", format: "email" },
  HttpUrl: { type: "string", format: "uri" },
  AnyUrl: { type: "string", format: "uri" },
  SecretStr: { type: "string", format: "password" },
};

const ANY_TYPES = new Set(["Any", "object", "dict", "Dict", "JSON", "Json"]);
const ARRAY_GENERICS = new Set([
  "list", "List", "set", "Set", "frozenset", "FrozenSet", "tuple", "Tuple",
  "Sequence", "MutableSequence", "Iterable", "Collection", "AbstractSet", "conlist", "conset",
]);
const MAP_GENERICS = new Set(["dict", "Dict", "Mapping", "MutableMapping", "DefaultDict", "OrderedDict"]);

/** Names the framework injects — never something a caller sends. */
const INJECTED_NAMES = new Set(["request", "response", "self", "cls", "req", "res"]);
const INJECTED_TYPES = new Set([
  "Request", "Response", "HttpRequest", "HttpResponse", "WebSocket", "BackgroundTasks", "HTTPConnection",
]);

/** Split `Foo[A, B[C]]` into `{ name: "Foo", args: ["A", "B[C]"] }`; a non-generic → `{ name, args: [] }`. */
export function splitGeneric(type: string): { name: string; args: string[] } {
  const lb = type.indexOf("[");
  if (lb < 0 || !type.endsWith("]")) return { name: type, args: [] };
  return { name: type.slice(0, lb).trim(), args: splitTopLevel(type.slice(lb + 1, -1)) };
}

/** Split on commas (or `|` when `sep` says so) that are outside brackets/parens/quotes. */
export function splitTopLevel(text: string, sep: "," | "|" = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

/** Drop module qualification (`typing.Optional` → `Optional`, `datetime.datetime` → `datetime`). */
function simpleName(name: string): string {
  return name.replace(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\./, "");
}

/** `Annotated[T, Query(...)]` → `T`; a forward reference `"User"` → `User`. */
function unwrapAnnotated(type: string): string {
  let t = type.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  const g = splitGeneric(t);
  if (simpleName(g.name) === "Annotated" && g.args.length > 0) return unwrapAnnotated(g.args[0]!);
  return t;
}

/** `Optional[T]` / `T | None` / `Union[T, None]` → `{ type: T, nullable: true }`. */
export function unwrapNullable(type: string): { type: string; nullable: boolean } {
  const t = unwrapAnnotated(type);
  const union = splitTopLevel(t, "|");
  if (union.length > 1) {
    const rest = union.filter((u) => u !== "None");
    if (rest.length < union.length) return { type: rest.length === 1 ? rest[0]! : rest.join(" | "), nullable: true };
    return { type: t, nullable: false };
  }
  const g = splitGeneric(t);
  const name = simpleName(g.name);
  if (name === "Optional" && g.args.length === 1) return { type: unwrapNullable(g.args[0]!).type, nullable: true };
  if (name === "Union") {
    const rest = g.args.filter((a) => a !== "None");
    if (rest.length < g.args.length) {
      return { type: rest.length === 1 ? unwrapNullable(rest[0]!).type : `Union[${rest.join(", ")}]`, nullable: true };
    }
  }
  return { type: t, nullable: false };
}

export function describeType(type: string): TypeShape {
  const t = unwrapAnnotated(type);
  const g = splitGeneric(t);
  const name = simpleName(g.name);
  if (g.args.length === 0) {
    const scalar = SCALARS[name];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY_TYPES.has(name) || ARRAY_GENERICS.has(name) && name !== "list" && name !== "List") return { kind: "any" };
    if (name === "list" || name === "List") return { kind: "array", element: "Any" };
    return { kind: "object", name: t };
  }
  if (name === "Literal") {
    const values = g.args.map((a) => a.replace(/^["']|["']$/g, ""));
    const allNumeric = g.args.every((a) => /^-?\d+$/.test(a));
    return { kind: "scalar", schema: allNumeric ? { type: "integer", enum: values } : { type: "string", enum: values } };
  }
  if (ARRAY_GENERICS.has(name)) {
    // `tuple[int, ...]` / `Tuple[str, str]` — element is the first member.
    return { kind: "array", element: g.args[0]! };
  }
  if (MAP_GENERICS.has(name)) return g.args.length >= 2 ? { kind: "map", value: g.args[1]! } : { kind: "any" };
  if (name === "Union") return { kind: "any" };
  if (name === "Type" || name === "type") return { kind: "any" };
  return { kind: "object", name: t };
}

/** `Field(..., alias="user_name")` → `user_name`; `Field(validation_alias="x")` counts too. */
function fieldAlias(decorators: readonly string[] | undefined): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:\w+\.)?Field\s*\((.*)\)\s*$/s);
    if (!m) continue;
    const alias = m[1]!.match(/\b(?:alias|validation_alias)\s*=\s*["']([^"']*)["']/);
    if (alias) return alias[1]!;
  }
  return null;
}

/** FastAPI's default rule for a signature no annotation binds: see routes.ts. */
export function bindParam(param: ParamInfo, _route: RouteInfo): RouteParamBinding | null {
  if (INJECTED_NAMES.has(param.name)) return "services";
  if (param.type && INJECTED_TYPES.has(simpleName(unwrapNullable(param.type).type))) return "services";
  if (param.defaultValue && /^(?:Depends|Security)\s*\(/.test(param.defaultValue)) return "services";
  return null;
}

export const pythonRequestSchema: RequestSchemaHooks = {
  bindParam,
  unwrapNullable,
  describeType,

  serializedName(prop: PropertyInfo) {
    return fieldAlias(prop.decorators) ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.name.startsWith("_")) return false;
    if (prop.name === "model_config" || prop.name === "Config") return false;
    if (prop.type && /^(?:typing\.)?ClassVar\b/.test(prop.type)) return false;
    if (prop.isStatic) return false;
    if ((prop.decorators ?? []).some((d) => /\bexclude\s*=\s*True\b/.test(d))) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
