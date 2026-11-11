import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How the Thrift field types `index.ts` writes (`i64`, `Player[]` for a list
 * or set, `map<string,Player>`) read as JSON Schema — the JSON protocol's
 * shapes: `binary` is base64. A struct type is resolved by name by the core
 * pass.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  bool: { type: "boolean" }, byte: { type: "integer", format: "int8" }, i8: { type: "integer", format: "int8" },
  i16: { type: "integer", format: "int16" }, i32: { type: "integer", format: "int32" }, i64: { type: "integer", format: "int64" },
  double: { type: "number", format: "double" }, string: { type: "string" }, binary: { type: "string", format: "byte" }, uuid: { type: "string", format: "uuid" },
};

export const thriftRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    return { type: type.trim(), nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
    const map = /^map<[^,]+,(.+)>$/.exec(t);
    if (map) return { kind: "map", value: map[1]! };
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    // A qualified name (`shared.Player`) resolves by its struct name.
    return { kind: "object", name: t.split(".").pop()! };
  },

  serializedName(prop: PropertyInfo) {
    return prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    // An enum's values are static members, not fields.
    return !prop.isStatic;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
