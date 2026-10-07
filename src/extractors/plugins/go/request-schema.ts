import type { ParamInfo, PropertyInfo, RouteParamBinding } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Go types and struct fields look on the wire under `encoding/json` (what
 * gin, echo, chi, fiber and net/http all end up calling). Consumed by the
 * language-agnostic request-schema pass; nothing here walks classes or routes.
 *
 * Struct-field types arrive as written (`*Address`, `[]string`,
 * `map[string]any`, `store.Product`) — the Go property pattern keeps the type
 * text raw precisely so the pointer/slice/map shape is still visible here.
 * Backtick tags arrive as one decorator per key: `json:"name,omitempty"`,
 * `validate:"required"`, `binding:"required"`, `form:"q"`, `uri:"id"`.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" },
  rune: { type: "string" },
  int: { type: "integer", format: "int64" }, int8: { type: "integer", format: "int32" },
  int16: { type: "integer", format: "int32" }, int32: { type: "integer", format: "int32" },
  int64: { type: "integer", format: "int64" },
  uint: { type: "integer", format: "int64" }, uint8: { type: "integer", format: "int32" },
  uint16: { type: "integer", format: "int32" }, uint32: { type: "integer", format: "int32" },
  uint64: { type: "integer", format: "int64" }, uintptr: { type: "integer", format: "int64" },
  byte: { type: "integer", format: "int32" },
  float32: { type: "number", format: "float" }, float64: { type: "number", format: "double" },
  bool: { type: "boolean" },
  "time.Time": { type: "string", format: "date-time" },
  "time.Duration": { type: "string", format: "duration" },
  "uuid.UUID": { type: "string", format: "uuid" },
  "json.Number": { type: "number" },
  "decimal.Decimal": { type: "number" },
  "sql.NullString": { type: "string" },
  "sql.NullInt64": { type: "integer", format: "int64" },
  "sql.NullInt32": { type: "integer", format: "int32" },
  "sql.NullFloat64": { type: "number", format: "double" },
  "sql.NullBool": { type: "boolean" },
  "sql.NullTime": { type: "string", format: "date-time" },
  "primitive.ObjectID": { type: "string" },
};

const ANY_TYPES = new Set(["interface{}", "any", "json.RawMessage", "map[string]interface{}", "map[string]any"]);

/**
 * Framework-injected handler parameters — the request/response/context
 * objects every Go web framework hands a handler. The regex param parser
 * strips the leading `*`, so `*gin.Context` arrives as `gin.Context`.
 */
const SERVICE_TYPES = new Set([
  "gin.Context", "echo.Context", "fiber.Ctx", "iris.Context", "context.Context",
  "http.ResponseWriter", "http.Request", "httprouter.Params", "http.Handler", "http.HandlerFunc",
  "buffalo.Context", "beego.Controller", "web.Controller", "revel.Controller",
]);

/** `map[K]V` → V, honouring nested brackets in K (`map[[2]int]V`). */
function mapValue(type: string): string | null {
  if (!type.startsWith("map[")) return null;
  let depth = 0;
  for (let i = 3; i < type.length; i++) {
    const ch = type[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return type.slice(i + 1).trim();
    }
  }
  return null;
}

/** `tag:"value"` decorator → value, or null when the tag is absent. */
function tagValue(decorators: readonly string[] | undefined, key: string): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(\w+):"((?:[^"\\]|\\.)*)"$/);
    if (m && m[1] === key) return m[2]!;
  }
  return null;
}

function hasRequiredTag(decorators: readonly string[] | undefined): boolean {
  for (const key of ["validate", "binding", "valid"]) {
    const v = tagValue(decorators, key);
    if (v && v.split(",").some((t) => t.trim() === "required")) return true;
  }
  return false;
}

export const goRequestSchema: RequestSchemaHooks = {
  bindParam(param: ParamInfo, _route): RouteParamBinding | null {
    const t = (param.type ?? "").replace(/^[*&]+/, "").trim();
    if (!t) return null;
    if (SERVICE_TYPES.has(t)) return "services";
    // A package-qualified framework type we did not list, by its recognisable
    // leaf: `Context`, `ResponseWriter`, `Request`, `Ctx`.
    const leaf = t.split(".").pop()!;
    const pkg = t.includes(".") ? t.split(".")[0]! : "";
    if (pkg && ["gin", "echo", "fiber", "http", "iris", "context", "httprouter"].includes(pkg)) return "services";
    if (["ResponseWriter", "Context", "Ctx"].includes(leaf)) return "services";
    return null;
  },

  unwrapNullable(type) {
    const t = type.trim();
    if (t.startsWith("*")) return { type: t.slice(1).trim(), nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.replace(/\s+/g, "").trim();
    if (t === "[]byte") return { kind: "scalar", schema: { type: "string", format: "byte" } };
    if (t.startsWith("[]")) return { kind: "array", element: t.slice(2) };
    const fixed = t.match(/^\[\s*(?:\d+|\.\.\.)\s*\](.+)$/);
    if (fixed) return { kind: "array", element: fixed[1]! };
    const value = mapValue(t);
    if (value !== null) {
      if (value === "interface{}" || value === "any") return { kind: "any" };
      return { kind: "map", value };
    }
    if (ANY_TYPES.has(t)) return { kind: "any" };
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    const json = tagValue(prop.decorators, "json");
    if (json) {
      const name = json.split(",")[0]!.trim();
      if (name && name !== "-") return name;
    }
    return prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    // An embedded struct without a json name is flattened into its parent by
    // encoding/json — it is not a field of its own (the flattening itself is
    // not modelled, so it is left out rather than shown as a nested object).
    if (prop.decorators?.includes("embedded") && !tagValue(prop.decorators, "json")) return false;
    // encoding/json only sees exported fields; `json:"-"` opts one out.
    if (!/^[A-Z]/.test(prop.name)) return false;
    const json = tagValue(prop.decorators, "json");
    if (json !== null && json.split(",")[0]!.trim() === "-") return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true || hasRequiredTag(prop.decorators);
  },
};
