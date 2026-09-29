import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How the XSD type names `index.ts` writes onto WSDL entity properties (prefix
 * stripped: `int`, `dateTime`, `Order[]`, `string?` for nillable) read as JSON
 * Schema for the request-schema pass. XSD scalars map to JSON types with the
 * OpenAPI formats; anything else is a `complexType` the core pass resolves by
 * name.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" }, normalizedString: { type: "string" }, token: { type: "string" },
  QName: { type: "string" }, NCName: { type: "string" }, Name: { type: "string" }, language: { type: "string" },
  int: { type: "integer", format: "int32" }, integer: { type: "integer" },
  long: { type: "integer", format: "int64" }, short: { type: "integer", format: "int32" },
  byte: { type: "integer", format: "int32" }, unsignedInt: { type: "integer", format: "int32" },
  unsignedLong: { type: "integer", format: "int64" }, unsignedShort: { type: "integer", format: "int32" },
  unsignedByte: { type: "integer", format: "int32" }, positiveInteger: { type: "integer" },
  nonNegativeInteger: { type: "integer" }, negativeInteger: { type: "integer" }, nonPositiveInteger: { type: "integer" },
  decimal: { type: "number" }, double: { type: "number", format: "double" }, float: { type: "number", format: "float" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" }, dateTime: { type: "string", format: "date-time" },
  time: { type: "string", format: "time" }, duration: { type: "string", format: "duration" },
  gYear: { type: "string" }, gYearMonth: { type: "string" }, gMonth: { type: "string" }, gDay: { type: "string" }, gMonthDay: { type: "string" },
  base64Binary: { type: "string", format: "byte" }, hexBinary: { type: "string" },
  anyURI: { type: "string", format: "uri" },
};

const ANY_TYPES = new Set(["anyType", "any", "anySimpleType"]);

export const wsdlRequestSchema: RequestSchemaHooks = {
  unwrapNullable(type) {
    const t = type.trim();
    return t.endsWith("?") ? { type: t.slice(0, -1), nullable: true } : { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim().replace(/^[A-Za-z_][\w.-]*:/, "");
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
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
