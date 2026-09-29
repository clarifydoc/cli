import { describe, it, expect } from "vitest";
import { classifyRustParamType, rustRequestSchema as h } from "./request-schema.js";
import { parseRustParam } from "./params.js";
import { extractFunctionsWithSpec, extractClassesWithSpec } from "../shared/regex-base.js";
import { rustSpec } from "./index.js";

const route = { path: "/users/:id", httpMethod: "POST", kind: "api" as const, handler: null, calls: [], middleware: [], line: 1 };
const lines = (src: string) => src.split("\n");

describe("Rust request-schema hooks", () => {
  it("unwraps Option, transparent pointers and extractor wrappers", () => {
    expect(h.unwrapNullable("Option<String>")).toEqual({ type: "String", nullable: true });
    expect(h.unwrapNullable("Json<CreateUser>")).toEqual({ type: "CreateUser", nullable: false });
    expect(h.unwrapNullable("web::Json<CreateUser>")).toEqual({ type: "CreateUser", nullable: false });
    expect(h.unwrapNullable("Option<Box<Address>>")).toEqual({ type: "Address", nullable: true });
    expect(h.unwrapNullable("Vec<String>")).toEqual({ type: "Vec<String>", nullable: false });
    expect(h.unwrapNullable("&'static str")).toEqual({ type: "str", nullable: false });
  });

  it("classifies scalars, collections, maps, dates and unknown structs", () => {
    expect(h.describeType("String")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("str")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("i32")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int32" } });
    expect(h.describeType("u64")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("usize")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("f64")).toEqual({ kind: "scalar", schema: { type: "number", format: "double" } });
    expect(h.describeType("bool")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("Uuid")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("DateTime<Utc>")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("chrono::NaiveDate")).toEqual({ kind: "scalar", schema: { type: "string", format: "date" } });
    expect(h.describeType("Decimal")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("Vec<Address>")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("HashSet<String>")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("[u8; 16]")).toEqual({ kind: "array", element: "u8" });
    expect(h.describeType("&[Item]")).toEqual({ kind: "array", element: "Item" });
    expect(h.describeType("HashMap<String, Vec<u8>>")).toEqual({ kind: "map", value: "Vec<u8>" });
    expect(h.describeType("BTreeMap<String, Address>")).toEqual({ kind: "map", value: "Address" });
    expect(h.describeType("Box<Address>")).toEqual({ kind: "object", name: "Address" });
    expect(h.describeType("serde_json::Value")).toEqual({ kind: "any" });
    expect(h.describeType("Value")).toEqual({ kind: "any" });
    expect(h.describeType("models::CreateUser")).toEqual({ kind: "object", name: "models::CreateUser" });
  });

  it("reads serde attributes off a field's decorators and Option off its type", () => {
    const p = (type: string, decorators?: string[]) => ({
      name: "user_name", type, visibility: "public" as const, isStatic: false, isReadonly: false, decorators,
    });
    expect(h.serializedName(p("String", ['serde(rename = "userName")']))).toBe("userName");
    expect(h.serializedName(p("String", ['serde(default, rename = "userName", skip_serializing_if = "x")']))).toBe("userName");
    expect(h.serializedName(p("String"))).toBe("user_name"); // struct-level rename_all is not visible here
    expect(h.isSerialized(p("String"))).toBe(true);
    expect(h.isSerialized(p("String", ["serde(skip)"]))).toBe(false);
    expect(h.isSerialized(p("String", ["serde(skip_deserializing)"]))).toBe(false);
    expect(h.isSerialized(p("String", ['serde(skip_serializing_if = "Option::is_none")']))).toBe(true);
    expect(h.isRequired(p("String"))).toBe(true);
    expect(h.isRequired(p("Option<String>"))).toBe(false);
    expect(h.isRequired(p("String", ["serde(default)"]))).toBe(false);
    expect(h.isRequired(p("Vec<String>", ['serde(default = "empty")']))).toBe(false);
  });

  it("binds handler params by extractor type for the project-level join", () => {
    const bind = (name: string, type: string) => h.bindParam!({ name, type, defaultValue: null }, route);
    expect(bind("payload", "Json<CreateUser>")).toBe("body");
    expect(bind("body", "axum::Json<CreateUser>")).toBe("body");
    expect(bind("body", "web::Json<CreateUser>")).toBe("body");
    expect(bind("form", "Form<Login>")).toBe("form");
    expect(bind("params", "Query<ListParams>")).toBe("query");
    expect(bind("params", "Option<Query<ListParams>>")).toBe("query");
    expect(bind("id", "Path<u64>")).toBe("route");
    expect(bind("headers", "HeaderMap")).toBe("header");
    expect(bind("auth", "TypedHeader<Authorization<Bearer>>")).toBe("header");
    expect(bind("multipart", "Multipart")).toBe("form");
    expect(bind("raw", "String")).toBe("body");
    expect(bind("raw", "Bytes")).toBe("body");
    expect(bind("state", "State<AppState>")).toBe("services");
    expect(bind("claims", "Extension<Claims>")).toBe("services");
    expect(bind("data", "web::Data<AppState>")).toBe("services");
    expect(bind("data", "Data<'_>")).toBe("body"); // Rocket's raw body, not actix app data
    expect(bind("req", "HttpRequest")).toBe("services");
    expect(bind("addr", "ConnectInfo<SocketAddr>")).toBe("services");
    expect(bind("user", "AuthUser")).toBe("services");
    expect(bind("n", "u64")).toBeNull();
    expect(classifyRustParamType("Result<Json<CreateUser>, JsonRejection>")).toEqual({ binding: "body", inner: "CreateUser", guard: null });
    expect(classifyRustParamType("Claims").guard).toBe("Claims");
  });
});

describe("Rust params and attributes through the spec", () => {
  it("parses destructured extractor params and keeps the wrapper type", () => {
    expect(parseRustParam("Json(payload): Json<CreateUser>")).toEqual({ name: "payload", type: "Json<CreateUser>", defaultValue: null });
    expect(parseRustParam("Path((id, sub)): Path<(u64, u64)>")).toEqual({ name: "id", type: "Path<(u64, u64)>", defaultValue: null });
    expect(parseRustParam("Query(ListParams { page, .. }): Query<ListParams>")).toEqual({ name: "page", type: "Query<ListParams>", defaultValue: null });
    expect(parseRustParam("mut body: web::Json<User>")).toEqual({ name: "body", type: "web::Json<User>", defaultValue: null });
    expect(parseRustParam("&self")).toBeNull();
    expect(parseRustParam("self: Pin<&mut Self>")).toBeNull();
    const fns = extractFunctionsWithSpec(lines(`
async fn create_user(
    State(repo): State<AppState>,
    Json(payload): Json<CreateUser>,
) -> Json<User> {
    todo!()
}
`), rustSpec);
    expect(fns[0]!.params).toEqual([
      { name: "repo", type: "State<AppState>", defaultValue: null },
      { name: "payload", type: "Json<CreateUser>", defaultValue: null },
    ]);
  });

  it("attaches own-line attributes as decorators on structs, fields and fns", () => {
    const src = lines(`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUser {
    #[serde(rename = "user_name")]
    pub name: String,
    pub email: Option<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    pub attrs: HashMap<String, String>,
    #[serde(skip)]
    pub internal: bool,
}

#[get("/users")]
#[tracing::instrument]
async fn list_users() -> String { todo!() }
`);
    const cls = extractClassesWithSpec(src, rustSpec)[0]!;
    expect(cls.decorators).toEqual(["derive(Debug, Deserialize)", 'serde(rename_all = "camelCase")']);
    const props = Object.fromEntries(cls.properties.map((p) => [p.name, p]));
    expect(props["name"]!.decorators).toEqual(['serde(rename = "user_name")']);
    expect(props["email"]!.decorators).toBeUndefined();
    expect(props["email"]!.type).toBe("Option<String>");
    expect(props["roles"]!.decorators).toEqual(["serde(default)"]);
    expect(props["attrs"]!.type).toBe("HashMap<String, String>");
    expect(props["internal"]!.decorators).toEqual(["serde(skip)"]);
    const fn = extractFunctionsWithSpec(src, rustSpec)[0]!;
    expect(fn.decorators).toEqual(['get("/users")', "tracing::instrument"]);
  });
});
