import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Ecto field types serialize under Jason/Poison — the only typed shape an
 * Elixir request body has (`field :age, :integer`, `{:array, :string}`,
 * `Ecto.Enum`, an embedded schema module). The language-agnostic
 * request-schema pass owns the recursion; these hooks map one type text.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  ":string": { type: "string" },
  ":binary": { type: "string", format: "byte" },
  ":integer": { type: "integer" },
  ":id": { type: "integer" },
  ":float": { type: "number", format: "double" },
  ":decimal": { type: "number" },
  ":boolean": { type: "boolean" },
  ":date": { type: "string", format: "date" },
  ":time": { type: "string", format: "time" },
  ":time_usec": { type: "string", format: "time" },
  ":naive_datetime": { type: "string", format: "date-time" },
  ":naive_datetime_usec": { type: "string", format: "date-time" },
  ":utc_datetime": { type: "string", format: "date-time" },
  ":utc_datetime_usec": { type: "string", format: "date-time" },
  ":binary_id": { type: "string", format: "uuid" },
  "Ecto.UUID": { type: "string", format: "uuid" },
  "Ecto.Enum": { type: "string" },
};

export const elixirRequestSchema: RequestSchemaHooks = {
  bindParam(param) {
    if (param.name === "conn" || param.name === "socket") return "services";
    return null;
  },

  unwrapNullable(type) {
    // Ecto fields are nullable by default; the schema carries no marker, so nothing to unwrap.
    return { type: type.trim(), nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const arr = t.match(/^\{\s*:array\s*,\s*(.+)\}$/);
    if (arr) return { kind: "array", element: arr[1]!.trim() };
    if (t === ":map" || t === ":any" || t === "map" || /^\{\s*:map\s*,/.test(t)) return { kind: "any" };
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (t.startsWith(":")) return { kind: "scalar", schema: { type: "string" } };
    // A module name (`MyApp.Accounts.Address`) — the last segment names the schema module.
    return { kind: "object", name: t.split(".").pop() ?? t };
  },

  serializedName(prop: PropertyInfo) {
    return prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    return !prop.name.startsWith("__");
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
