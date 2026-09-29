import type { ParamInfo, PropertyInfo, RouteInfo, RouteParamBinding } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How TypeScript types and class properties look on the wire — NestJS DTOs
 * with class-validator (`@IsOptional()`, `@IsDefined()`) and class-transformer
 * (`@Expose({ name })`, `@Exclude()`) markers, plus the Swagger
 * `@ApiProperty` name. Consumed by the language-agnostic request-schema pass;
 * nothing here walks classes or routes.
 *
 * `bindParam` serves the other JS frameworks: an Express/Koa/Fastify handler
 * declared away from its route line (`router.get('/', getUsers)`) has no
 * bindings in its signature, only the framework objects — those are named
 * `services` so a reader skips them, and everything else comes from the
 * function's `requestAccess`.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" },
  String: { type: "string" },
  number: { type: "number" },
  Number: { type: "number" },
  boolean: { type: "boolean" },
  Boolean: { type: "boolean" },
  bigint: { type: "integer", format: "int64" },
  BigInt: { type: "integer", format: "int64" },
  Date: { type: "string", format: "date-time" },
};

const ANY_TYPES = new Set(["any", "unknown", "object", "Object", "{}", "null", "never", "void", "undefined"]);

const ARRAY_GENERICS = new Set(["Array", "ReadonlyArray", "Set", "ReadonlySet"]);
const MAP_GENERICS = new Set(["Record", "Map", "ReadonlyMap"]);
/** Wrappers that do not change the JSON shape of their argument. */
const TRANSPARENT_GENERICS = new Set(["Promise", "Partial", "Required", "Readonly", "NonNullable", "Awaited", "DeepPartial"]);

/** Names of the framework's request/response objects, by parameter name and by type. */
const SERVICE_PARAM_NAMES = new Set(["req", "request", "ctx", "context", "res", "response", "reply", "next"]);
const SERVICE_TYPES = /^(?:express\.)?(?:Request|Response|NextFunction|FastifyRequest|FastifyReply|Context|Koa\.Context|ParameterizedContext)(?:<.*>)?$/;

/** `Foo<A, B<C>>` → `{ name: "Foo", args: ["A", "B<C>"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  return { name: type.slice(0, lt), args: splitTopLevel(type.slice(lt + 1, -1), ",") };
}

/** Split on a separator at nesting depth 0 (respecting `<>`, `()`, `[]`, `{}` and quotes). */
function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

/** `(A | B)` → `A | B`, once, when the parentheses wrap the whole text. */
function unparen(type: string): string {
  const t = type.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    if (depth === 0 && i < t.length - 1) return t;
  }
  return t.slice(1, -1).trim();
}

const STRING_LITERAL = /^(['"`])(.*)\1$/s;

/** Arguments of a decorator by name: `Expose({ name: 'x' })` → `{ name: 'x' }`; null when absent. */
function decoratorArgs(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w$]+\.)?(\w+)\s*\((.*)\)\s*$/s);
    if (m && names.includes(m[1]!)) return m[2]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => {
    const m = d.match(/^(?:[\w$]+\.)?(\w+)(?:\s*\(|$)/);
    return !!m && names.includes(m[1]!);
  });
}

/** Classify a (non-nullable) TypeScript type text. */
function describeType(type: string): TypeShape {
  const t = unparen(type);
  if (ANY_TYPES.has(t)) return { kind: "any" };
  // `T[]` — the suffix binds tighter than `|`, so `(A | B)[]` reaches here whole.
  if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2).trim() };
  // `'a' | 'b'` — an enum of strings; a union of anything else has no single shape.
  const members = splitTopLevel(t, "|");
  if (members.length > 1) {
    const literals = members.map((m) => m.match(STRING_LITERAL)?.[2]);
    if (literals.every((l): l is string => typeof l === "string")) {
      return { kind: "scalar", schema: { type: "string", enum: literals } };
    }
    return { kind: "any" };
  }
  const single = t.match(STRING_LITERAL);
  if (single) return { kind: "scalar", schema: { type: "string", enum: [single[2]!] } };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "scalar", schema: { type: "number" } };
  if (t === "true" || t === "false") return { kind: "scalar", schema: { type: "boolean" } };
  // Inline object literal type — a shape, but one no class lookup can flatten.
  if (t.startsWith("{")) return { kind: "any" };
  const g = splitGeneric(t);
  if (g.args.length === 1 && ARRAY_GENERICS.has(g.name)) return { kind: "array", element: g.args[0]! };
  if (g.args.length === 1 && TRANSPARENT_GENERICS.has(g.name)) return describeType(g.args[0]!);
  if (g.args.length === 2 && MAP_GENERICS.has(g.name)) return { kind: "map", value: g.args[1]! };
  if (g.args.length === 0) {
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
  }
  return { kind: "object", name: t };
}

export const javascriptRequestSchema: RequestSchemaHooks = {
  bindParam(param: ParamInfo, _route: RouteInfo): RouteParamBinding | null {
    if (SERVICE_PARAM_NAMES.has(param.name)) return "services";
    if (param.type && SERVICE_TYPES.test(param.type.trim())) return "services";
    return null;
  },

  unwrapNullable(type) {
    let t = unparen(type);
    if (t.endsWith("?")) t = t.slice(0, -1).trim();
    const members = splitTopLevel(t, "|");
    const kept = members.filter((m) => m !== "null" && m !== "undefined");
    if (kept.length === members.length) return { type: t, nullable: false };
    // `null` alone stays `null` (an "any" for describeType) rather than "".
    return { type: kept.length > 0 ? kept.join(" | ") : "null", nullable: true };
  },

  describeType,

  serializedName(prop: PropertyInfo) {
    // class-transformer `@Expose({ name: 'user_name' })`, Swagger `@ApiProperty({ name })`.
    const objectArgs = decoratorArgs(prop.decorators, ["Expose", "ApiProperty", "ApiPropertyOptional"]);
    const named = objectArgs?.match(/\bname\s*:\s*(['"`])([^'"`]+)\1/);
    if (named) return named[2]!;
    // `@JsonProperty('x')` (json2typescript and friends).
    const positional = decoratorArgs(prop.decorators, ["JsonProperty"]);
    const str = positional?.match(/^\s*(['"`])([^'"`]+)\1/);
    if (str) return str[2]!;
    return prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (prop.visibility === "private" || prop.visibility === "protected") return false;
    if (prop.name.startsWith("#")) return false;
    if (hasDecorator(prop.decorators, ["Exclude"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    if (hasDecorator(prop.decorators, ["IsOptional", "ApiPropertyOptional"])) return false;
    if (hasDecorator(prop.decorators, ["IsDefined", "IsNotEmpty"])) return true;
    return prop.isRequired === true;
  },
};
