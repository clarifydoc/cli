import type { ParamInfo, PropertyInfo, RouteParamBinding } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Rust types and struct fields look on the wire under serde (what axum,
 * actix-web and Rocket all serialize with), plus where a handler parameter
 * binds from by its extractor type. Consumed by the language-agnostic
 * request-schema pass and the project-level handler join; nothing here walks
 * classes or routes.
 *
 * Field attributes arrive as decorators from their own line above the field
 * (`serde(rename = "user_name")`, `serde(skip)`, `serde(default)`) — the
 * regex spec's `attributeLine` collects them. A struct-level
 * `#[serde(rename_all = "camelCase")]` is NOT visible from a property (the
 * hooks see one property at a time), so a field without its own rename keeps
 * its declared name; that is the one known gap.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  String: { type: "string" }, str: { type: "string" }, char: { type: "string" },
  i8: { type: "integer", format: "int32" }, i16: { type: "integer", format: "int32" },
  i32: { type: "integer", format: "int32" }, i64: { type: "integer", format: "int64" },
  i128: { type: "integer", format: "int64" }, isize: { type: "integer", format: "int64" },
  u8: { type: "integer", format: "int32" }, u16: { type: "integer", format: "int32" },
  u32: { type: "integer", format: "int32" }, u64: { type: "integer", format: "int64" },
  u128: { type: "integer", format: "int64" }, usize: { type: "integer", format: "int64" },
  f32: { type: "number", format: "float" }, f64: { type: "number", format: "double" },
  bool: { type: "boolean" },
  Uuid: { type: "string", format: "uuid" },
  NaiveDateTime: { type: "string", format: "date-time" },
  NaiveDate: { type: "string", format: "date" },
  NaiveTime: { type: "string", format: "time" },
  OffsetDateTime: { type: "string", format: "date-time" },
  PrimitiveDateTime: { type: "string", format: "date-time" },
  SystemTime: { type: "string", format: "date-time" },
  Date: { type: "string", format: "date" },
  Duration: { type: "string", format: "duration" },
  Decimal: { type: "number" },
  BigDecimal: { type: "number" },
  Url: { type: "string", format: "uri" },
  PathBuf: { type: "string" },
  IpAddr: { type: "string" },
};
/** Generic scalars whose argument says nothing about the wire shape. */
const SCALAR_GENERICS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  DateTime: { type: "string", format: "date-time" },
  Cow: { type: "string" },
};

const ANY_TYPES = new Set(["Value", "serde_json::Value", "RawValue", "Map"]);
const ARRAY_GENERICS = new Set(["Vec", "VecDeque", "LinkedList", "HashSet", "BTreeSet", "BinaryHeap", "IndexSet", "SmallVec", "Set"]);
const MAP_GENERICS = new Set(["HashMap", "BTreeMap", "IndexMap", "DashMap"]);
/** Smart pointers and cells that serialize as their content. */
const TRANSPARENT = new Set(["Box", "Arc", "Rc", "Cell", "RefCell", "Mutex", "RwLock", "Cow"]);

/**
 * Request extractors by their outer type name (last `::` segment, generic
 * argument dropped): `Json<T>`/`web::Json<T>`/`rocket::serde::json::Json<T>`
 * all bind the body. The generic argument is the payload type.
 */
const EXTRACTOR_BINDINGS: Record<string, RouteParamBinding> = {
  Json: "body", Form: "form", Query: "query", Path: "route",
  RawQuery: "query", RawForm: "form", Multipart: "form", MultipartForm: "form",
  HeaderMap: "header", TypedHeader: "header", Header: "header",
  Bytes: "body", String: "body", Body: "body", Payload: "body", BodyStream: "body", Text: "body", Data: "body",
  Xml: "body", Cbor: "body", MsgPack: "body", Protobuf: "body",
};
/** Framework-injected objects a handler receives that are not request data. */
const SERVICE_TYPES = new Set([
  "State", "Extension", "HttpRequest", "HttpResponse", "Request", "Parts", "ConnectInfo",
  "Cookies", "CookieJar", "PrivateCookieJar", "SignedCookieJar", "WebSocketUpgrade",
  "Host", "OriginalUri", "MatchedPath", "NestedPath", "Uri", "Method", "Version", "Session", "Identity",
  "ServiceConfig", "ReqData", "Shutdown", "Config", "Socket", "SocketAddr", "Sender", "Receiver", "Client", "Pool",
  "PgPool", "MySqlPool", "SqlitePool", "DatabaseConnection", "Connection", "Context", "Cancellation", "CancellationToken",
]);
/** actix `web::Data<T>` is app state, Rocket's bare `Data<'_>` is the body. */
const ACTIX_DATA_RE = /(?:^|::)web::Data\s*</;
/** A request-guard type by its name: `AuthUser`, `Claims`, `AdminUser`, `ApiKey`, `Session`. */
export const GUARD_TYPE_RE = /auth|claims|token|user|admin|apikey|api_key|session|principal|identity/i;

/** `Foo<A, B<C>>` → `{ name: "Foo", args: ["A", "B<C>"] }`; a non-generic → `{ name, args: [] }`. */
function splitGeneric(type: string): { name: string; args: string[] } {
  const lt = type.indexOf("<");
  if (lt < 0 || !type.endsWith(">")) return { name: type, args: [] };
  const inner = type.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return { name: type.slice(0, lt).trim(), args };
}

/** Drop the module path: `web::Json` → `Json`, `rocket::serde::json::Json` → `Json`. */
function leaf(name: string): string {
  return name.split("::").pop()!.trim();
}

/** `&'a mut T` / `&T` / `mut T` → `T`. */
function stripRefs(type: string): string {
  let t = type.trim();
  let prev = "";
  while (t !== prev) {
    prev = t;
    t = t.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, "").replace(/^mut\s+/, "").replace(/^(?:dyn|impl)\s+/, "").trim();
  }
  return t;
}

/**
 * What a handler parameter's type says about the parameter: the extractor
 * wrapper it comes through and the payload type inside it. `Option<Json<T>>`
 * and `Result<Json<T>, E>` (axum's fallible extractors) are looked through.
 */
export function classifyRustParamType(type: string): { binding: RouteParamBinding | null; inner: string; guard: string | null } {
  let t = stripRefs(type);
  for (let i = 0; i < 3; i++) {
    const g = splitGeneric(t);
    if ((leaf(g.name) === "Option" || leaf(g.name) === "Result") && g.args.length >= 1) t = stripRefs(g.args[0]!);
    else break;
  }
  const g = splitGeneric(t);
  const name = leaf(g.name);
  if (ACTIX_DATA_RE.test(t) || (name === "Data" && g.args.length === 1 && !/^'/.test(g.args[0]!))) {
    return { binding: "services", inner: t, guard: null };
  }
  const binding = EXTRACTOR_BINDINGS[name];
  if (binding) return { binding, inner: g.args[0] ?? t, guard: null };
  if (SERVICE_TYPES.has(name)) return { binding: "services", inner: t, guard: null };
  if (GUARD_TYPE_RE.test(name)) return { binding: "services", inner: t, guard: name };
  return { binding: null, inner: t, guard: null };
}

/** First string argument of a `serde(key = "x")` decorator. */
function serdeValue(decorators: readonly string[] | undefined, key: string): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^serde\s*\((.*)\)\s*$/s);
    if (!m) continue;
    const kv = m[1]!.match(new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*"([^"]*)"`));
    if (kv) return kv[1]!;
  }
  return null;
}

function hasSerdeFlag(decorators: readonly string[] | undefined, flags: readonly string[]): boolean {
  for (const d of decorators ?? []) {
    const m = d.match(/^serde\s*\((.*)\)\s*$/s);
    if (!m) continue;
    const parts = m[1]!.split(",").map((p) => p.trim().split(/\s*=/)[0]!.trim());
    if (parts.some((p) => flags.includes(p))) return true;
  }
  return false;
}

function describeRustType(type: string): TypeShape {
  const t = stripRefs(type);
  const slice = t.match(/^\[\s*(.+?)\s*(?:;\s*\d+\s*)?\]$/);
  if (slice) return { kind: "array", element: slice[1]! };
  const g = splitGeneric(t);
  const name = leaf(g.name);
  if (g.args.length === 1 && ARRAY_GENERICS.has(name)) return { kind: "array", element: g.args[0]! };
  if (g.args.length >= 2 && MAP_GENERICS.has(name)) return { kind: "map", value: g.args[1]! };
  if (g.args.length === 1 && TRANSPARENT.has(name)) return describeRustType(g.args[0]!);
  if (g.args.length >= 1 && SCALAR_GENERICS[name]) return { kind: "scalar", schema: { ...SCALAR_GENERICS[name]! } };
  if (g.args.length === 0) {
    const scalar = SCALARS[name];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY_TYPES.has(name) || ANY_TYPES.has(t)) return { kind: "any" };
  }
  if (name === "Map" || name === "Value") return { kind: "any" };
  return { kind: "object", name: t };
}

export const rustRequestSchema: RequestSchemaHooks = {
  bindParam(param: ParamInfo, _route): RouteParamBinding | null {
    if (!param.type) return null;
    return classifyRustParamType(param.type).binding;
  },

  /**
   * `Option<T>` → nullable T. Extractor wrappers (`Json<T>`, `web::Form<T>`)
   * and transparent pointers (`Box<T>`, `Arc<T>`) are peeled here too, so a
   * body parameter the handler join left as `Json<CreateUser>` resolves to
   * the `CreateUser` struct.
   */
  unwrapNullable(type) {
    let t = stripRefs(type);
    let nullable = false;
    for (let i = 0; i < 6; i++) {
      const g = splitGeneric(t);
      const name = leaf(g.name);
      if (g.args.length === 0) break;
      if (name === "Option") { nullable = true; t = stripRefs(g.args[0]!); continue; }
      if (TRANSPARENT.has(name) || name in EXTRACTOR_BINDINGS) { t = stripRefs(g.args[0]!); continue; }
      break;
    }
    return { type: t, nullable };
  },

  describeType(type): TypeShape {
    return describeRustType(type);
  },

  serializedName(prop: PropertyInfo) {
    return serdeValue(prop.decorators, "rename") ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    return !hasSerdeFlag(prop.decorators, ["skip", "skip_deserializing", "skip_serializing"]);
  },

  isRequired(prop: PropertyInfo) {
    if (prop.isRequired === true) return true;
    if (hasSerdeFlag(prop.decorators, ["default"])) return false;
    const g = splitGeneric(stripRefs(prop.type ?? ""));
    return leaf(g.name) !== "Option";
  },
};
