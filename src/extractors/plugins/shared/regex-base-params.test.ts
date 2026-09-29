import { describe, it, expect } from "vitest";
import { extractParamsFromDeclaration, splitTopLevel, attributeLinesAbove, extractFunctionsWithSpec, extractClassesWithSpec } from "./regex-base.js";
import type { RegexLangSpec } from "./regex-base.js";

describe("regex-path parameter lists", () => {
  it("takes the parens after the function NAME, so a Go receiver is not a parameter", () => {
    const params = extractParamsFromDeclaration(["func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {"], 0, "GetUser");
    expect(params.map((p) => p.name)).toEqual(["w", "r"]);
  });

  it("keeps nested parens and generics whole and follows a wrapped signature", () => {
    const lines = [
      "async fn create(",
      "    State(repo): State<AppState>,",
      "    Json(payload): Json<CreateUser>,",
      "    q: HashMap<String, String>,",
      ") -> impl IntoResponse {",
    ];
    const params = extractParamsFromDeclaration(lines, 0, "create", (t) => ({ name: t.trim(), type: null, defaultValue: null }));
    expect(params.map((p) => p.name)).toEqual(["State(repo): State<AppState>", "Json(payload): Json<CreateUser>", "q: HashMap<String, String>"]);
  });

  it("splitTopLevel ignores commas inside brackets and quotes", () => {
    expect(splitTopLevel('a, Map<K, V> b, f(x, y), "c,d"')).toEqual(["a", " Map<K, V> b", " f(x, y)", ' "c,d"']);
  });
});

describe("regex-path attribute lines", () => {
  const spec: RegexLangSpec = {
    language: "rust",
    extensions: [".rs"],
    functionPatterns: [{ pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/ }],
    classPatterns: [{ pattern: /^\s*(?:pub\s+)?struct\s+(\w+)/, getExtends: () => null }],
    importPatterns: [],
    lineCommentPrefixes: ["//"],
    attributeLine: { pattern: /^\s*#\[(.*)\]\s*$/ },
    propertyPatterns: [{ pattern: /^\s*(?:pub\s+)?(\w+):\s*([^,]+),?\s*$/, build: (m) => ({ name: m[1]!, type: m[2]!.trim(), visibility: "public", isStatic: false, isReadonly: false }) }],
  } as RegexLangSpec;

  it("stacked own-line attributes above a function, a struct and a field become decorators", () => {
    const lines = [
      "#[derive(Deserialize)]",
      "#[serde(rename_all = \"camelCase\")]",
      "pub struct CreateUser {",
      "    #[serde(rename = \"user_name\")]",
      "    pub name: String,",
      "",
      "    pub email: Option<String>,",
      "}",
      "",
      "#[post(\"/users\")]",
      "async fn create(body: Json<CreateUser>) {",
      "}",
    ];
    expect(attributeLinesAbove(lines, 2, spec)).toEqual(["derive(Deserialize)", 'serde(rename_all = "camelCase")']);
    const [cls] = extractClassesWithSpec(lines, spec);
    expect(cls!.decorators).toEqual(["derive(Deserialize)", 'serde(rename_all = "camelCase")']);
    expect(cls!.properties.map((p) => [p.name, p.decorators])).toEqual([
      ["name", ['serde(rename = "user_name")']],
      ["email", undefined],
    ]);
    const [fn] = extractFunctionsWithSpec(lines, spec);
    expect(fn!.decorators).toEqual(['post("/users")']);
  });

  it("extractRequestAccess output lands on the function", () => {
    const withAccess: RegexLangSpec = {
      ...spec,
      extractRequestAccess: (body) => (body.some((l) => l.includes("c.Query")) ? [{ name: "q", type: null, binding: "query" }] : []),
    };
    const [fn] = extractFunctionsWithSpec(["fn list(c: Ctx) {", "  let q = c.Query(\"q\");", "}"], withAccess);
    expect(fn!.requestAccess).toEqual([{ name: "q", type: null, binding: "query" }]);
  });
});
