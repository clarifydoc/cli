import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How the protobuf field types `index.ts` writes (`int64`, `Order[]` for a
 * repeated field, `map<string,Order>`) read as JSON Schema — proto3's JSON
 * mapping: 64-bit integers are strings, `bytes` base64, well-known types by
 * their JSON form. A message type is resolved by name by the core pass.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  double: { type: "number", format: "double" }, float: { type: "number", format: "float" },
  int32: { type: "integer", format: "int32" }, uint32: { type: "integer", format: "int32" }, sint32: { type: "integer", format: "int32" },
  fixed32: { type: "integer", format: "int32" }, sfixed32: { type: "integer", format: "int32" },
  int64: { type: "string", format: "int64" }, uint64: { type: "string", format: "int64" }, sint64: { type: "string", format: "int64" },
  fixed64: { type: "string", format: "int64" }, sfixed64: { type: "string", format: "int64" },
  bool: { type: "boolean" }, string: { type: "string" }, bytes: { type: "string", format: "byte" },
  "google.protobuf.Timestamp": { type: "string", format: "date-time" },
  "google.protobuf.Duration": { type: "string", format: "duration" },
  "google.protobuf.StringValue": { type: "string" }, "google.protobuf.BoolValue": { type: "boolean" },
  "google.protobuf.Int32Value": { type: "integer", format: "int32" }, "google.protobuf.Int64Value": { type: "string", format: "int64" },
  "google.protobuf.DoubleValue": { type: "number", format: "double" }, "google.protobuf.FieldMask": { type: "string" },
};
const ANY_TYPES = new Set(["google.protobuf.Any", "google.protobuf.Struct", "google.protobuf.Value", "google.protobuf.Empty"]);

export const protobufRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    return { type: type.trim(), nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim().replace(/^\./, "");
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
    const map = /^map<\s*[\w.]+\s*,\s*([\w.]+)\s*>$/.exec(t);
    if (map) return { kind: "map", value: map[1]! };
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY_TYPES.has(t)) return { kind: "any" };
    // A qualified name (`acme.v1.Order`) resolves by its message name.
    return { kind: "object", name: t.split(".").pop()! };
  },

  serializedName(prop: PropertyInfo) {
    // proto3 JSON uses lowerCamelCase field names.
    return prop.name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  },

  isSerialized() {
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
