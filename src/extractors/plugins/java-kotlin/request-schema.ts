import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Java and Kotlin types serialize under Jackson (Spring's default, and
 * kotlinx.serialization/Gson where the attribute is unambiguous). Consumed by
 * the language-agnostic request-schema pass; nothing here walks classes.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" }, CharSequence: { type: "string" }, char: { type: "string" }, Character: { type: "string" }, Char: { type: "string" },
  int: { type: "integer", format: "int32" }, Integer: { type: "integer", format: "int32" }, Int: { type: "integer", format: "int32" },
  long: { type: "integer", format: "int64" }, Long: { type: "integer", format: "int64" },
  short: { type: "integer", format: "int32" }, Short: { type: "integer", format: "int32" },
  byte: { type: "integer", format: "int32" }, Byte: { type: "integer", format: "int32" },
  BigInteger: { type: "integer" },
  double: { type: "number", format: "double" }, Double: { type: "number", format: "double" },
  float: { type: "number", format: "float" }, Float: { type: "number", format: "float" },
  BigDecimal: { type: "number" },
  boolean: { type: "boolean" }, Boolean: { type: "boolean" },
  UUID: { type: "string", format: "uuid" },
  LocalDate: { type: "string", format: "date" },
  LocalTime: { type: "string", format: "time" },
  LocalDateTime: { type: "string", format: "date-time" },
  Instant: { type: "string", format: "date-time" },
  ZonedDateTime: { type: "string", format: "date-time" },
  OffsetDateTime: { type: "string", format: "date-time" },
  Date: { type: "string", format: "date-time" },
  Timestamp: { type: "string", format: "date-time" },
  Duration: { type: "string", format: "duration" },
  Period: { type: "string", format: "duration" },
  URI: { type: "string", format: "uri" }, URL: { type: "string", format: "uri" },
};

const ANY_TYPES = new Set(["Object", "Any", "JsonNode", "ObjectNode", "JsonElement", "JsonObject", "Map"]);
const ARRAY_GENERICS = new Set([
  "List", "Set", "Collection", "Iterable", "ArrayList", "LinkedList", "HashSet", "LinkedHashSet", "TreeSet",
  "MutableList", "MutableSet", "MutableCollection", "Array", "Sequence", "Stream", "Flux", "Flow", "Page",
]);
const MAP_GENERICS = new Set(["Map", "HashMap", "LinkedHashMap", "TreeMap", "MutableMap", "SortedMap"]);
const WRAPPERS = new Set(["Optional", "Mono", "ResponseEntity", "HttpEntity", "Valid"]);

function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  const inner = type.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return { name: type.slice(0, lt), args };
}

function simpleName(name: string): string {
  return name.replace(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\./, "").replace(/^(in|out)\s+/, "");
}

/** `JsonProperty("x")` / `JsonProperty(value = "x")` / `SerializedName("x")` / `SerialName("x")`. */
function decoratorString(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w.]+:)?(?:[\w.]+\.)?(\w+)\s*\((.*)\)\s*$/s);
    if (!m || !names.includes(m[1]!)) continue;
    const named = m[2]!.match(/\bvalue\s*=\s*"([^"]*)"/);
    if (named) return named[1]!;
    const str = m[2]!.match(/"([^"]*)"/);
    if (str) return str[1]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => {
    const m = d.match(/^(?:[\w.]+:)?(?:[\w.]+\.)?(\w+)(?:\s*\(|$)/);
    return !!m && names.includes(m[1]!);
  });
}

/** The request objects Javalin and Spark hand a handler method (`getOne(Context ctx)`, `(Request req, Response res)`). */
const FRAMEWORK_HANDLER_TYPES = /^(?:io\.javalin\.http\.)?Context$|^(?:spark\.)?(?:Request|Response)$/;

export const jvmRequestSchema: RequestSchemaHooks = {
  // Spring and JAX-RS bind at the route, by annotation; a Javalin/Spark handler method takes the framework's request object.
  bindParam(param) {
    return FRAMEWORK_HANDLER_TYPES.test((param.type ?? "").trim()) ? "services" : null;
  },

  unwrapNullable(type) {
    const t = type.trim().replace(/^@\w+\s+/, "");
    if (t.endsWith("?")) return { type: t.slice(0, -1).trim(), nullable: true };
    const g = splitGeneric(t);
    if (simpleName(g.name) === "Optional" && g.args.length === 1) return { type: g.args[0]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
    const g = splitGeneric(t);
    const name = simpleName(g.name);
    if (g.args.length === 1 && ARRAY_GENERICS.has(name)) return { kind: "array", element: g.args[0]! };
    if (g.args.length === 1 && WRAPPERS.has(name)) return this.describeType(g.args[0]!);
    if (g.args.length === 2 && MAP_GENERICS.has(name)) return { kind: "map", value: g.args[1]! };
    if (g.args.length === 0) {
      if (name === "Array" || name === "ByteArray" || name === "IntArray") return { kind: "array", element: name === "ByteArray" ? "byte" : name === "IntArray" ? "int" : "Any" };
      const scalar = SCALARS[name];
      if (scalar) return { kind: "scalar", schema: { ...scalar } };
      if (ANY_TYPES.has(name)) return { kind: "any" };
    }
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    // Jackson serializes the property under its declared name unless renamed;
    // no casing policy applies by default.
    return decoratorString(prop.decorators, ["JsonProperty", "JsonAlias", "SerializedName", "SerialName", "JsonbProperty"]) ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    // Jackson reaches private fields through their getters — a Java DTO's
    // fields are private by convention and still the payload.
    if (hasDecorator(prop.decorators, ["JsonIgnore", "JsonbTransient", "Transient"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    if (prop.isRequired === true) return true;
    if (hasDecorator(prop.decorators, ["NotNull", "NotBlank", "NotEmpty", "Nonnull", "NonNull"])) return true;
    return (prop.decorators ?? []).some((d) => /^JsonProperty\s*\(.*required\s*=\s*true/.test(d));
  },
};
