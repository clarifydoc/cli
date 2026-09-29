import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How the type texts `index.ts` writes onto OpenAPI schema properties read
 * back as JSON Schema — the spec already speaks JSON Schema, so this is a
 * round trip: `integer(int64)` → `{ type: "integer", format: "int64" }`,
 * `Order[]` → array of `Order`, `object` → free-form, a bare name → the
 * component schema of that name (resolved by the core pass), `?` → nullable.
 */

const JSON_TYPES = new Set(["string", "integer", "number", "boolean"]);

export const openapiRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    const t = type.trim();
    return t.endsWith("?") ? { type: t.slice(0, -1), nullable: true } : { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
    const m = /^([a-z]+)(?:\(([^)]*)\))?$/.exec(t);
    if (m && JSON_TYPES.has(m[1]!)) {
      const schema: { type: "string" | "integer" | "number" | "boolean"; format?: string } = {
        type: m[1] as "string" | "integer" | "number" | "boolean",
      };
      if (m[2]) schema.format = m[2];
      return { kind: "scalar", schema };
    }
    if (t === "object" || t === "any" || t === "") return { kind: "any" };
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
