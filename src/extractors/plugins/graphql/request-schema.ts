import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How GraphQL type texts (kept as written by `index.ts`: `[Order!]!`,
 * `String`, `DateTime`) read as JSON Schema for the request-schema pass.
 * GraphQL inverts the usual convention — every type is nullable unless it
 * carries `!` — so `unwrapNullable` strips the `!` and reports its absence.
 * Built-in scalars map to their JSON types; the common custom scalars
 * (`DateTime`, `UUID`, `JSON`, …) to string formats or free-form; anything
 * else is an object/input type the core pass resolves by name.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" },
  ID: { type: "string" },
  Int: { type: "integer" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
  DateTime: { type: "string", format: "date-time" },
  Date: { type: "string", format: "date" },
  Time: { type: "string", format: "time" },
  Timestamp: { type: "string", format: "date-time" },
  UUID: { type: "string", format: "uuid" },
  Email: { type: "string", format: "email" },
  EmailAddress: { type: "string", format: "email" },
  URL: { type: "string", format: "uri" },
  URI: { type: "string", format: "uri" },
  Long: { type: "integer", format: "int64" },
  BigInt: { type: "integer", format: "int64" },
  Decimal: { type: "number" },
  BigDecimal: { type: "number" },
  Upload: { type: "string", format: "binary" },
};

const ANY_TYPES = new Set(["JSON", "JSONObject", "Any", "Object", "Map"]);

export const graphqlRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    const t = type.trim();
    return t.endsWith("!") ? { type: t.slice(0, -1).trim(), nullable: false } : { type: t, nullable: true };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.startsWith("[") && t.endsWith("]")) return { kind: "array", element: t.slice(1, -1).trim() };
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY_TYPES.has(t)) return { kind: "any" };
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    return prop.name;
  },

  isSerialized() {
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
