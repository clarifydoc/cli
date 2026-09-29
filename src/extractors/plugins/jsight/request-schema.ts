import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How the type texts `index.ts` writes onto JSight `TYPE` properties read as
 * JSON Schema: JSON type words with an optional `(format)` (`string(uuid)`),
 * `X[]` for arrays, `object`/`any` free-form, a bare name → the `TYPE @Name`
 * the core pass resolves. JSight has no nullable marker of its own (a
 * `{type: "null"}` example is free-form), so nothing unwraps.
 */

const JSON_TYPES = new Set(["string", "integer", "number", "boolean"]);

export const jsightRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    return { type: type.trim(), nullable: false };
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
