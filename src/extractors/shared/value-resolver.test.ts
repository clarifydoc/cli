import { describe, it, expect } from "vitest";
import {
  foldValue,
  splitTopLevel,
  toAppRelativeUrl,
  unquote,
  type Scope,
  type ValueExpr,
} from "./value-resolver.js";

const lit = (value: string): ValueExpr => ({ kind: "lit", value });
const concat = (...parts: ValueExpr[]): ValueExpr => ({ kind: "concat", parts });
const template = (...parts: ValueExpr[]): ValueExpr => ({ kind: "template", parts });
const ref = (name: string): ValueExpr => ({ kind: "ref", name });
const env = (name: string): ValueExpr => ({ kind: "env", name });
const opaque = (text: string): ValueExpr => ({ kind: "opaque", text });

describe("foldValue", () => {
  it("folds an all-literal concatenation to EXTRACTED with no hole", () => {
    const r = foldValue(concat(lit("/api/"), lit("users")), new Map());
    expect(r.text).toBe("/api/users");
    expect(r.confidence).toBe("EXTRACTED");
    expect(r.hadHole).toBe(false);
  });

  it("chases ref bindings multi-hop across a scope", () => {
    // const a = base; const base = "/api/v2"; url = a + "/users"
    const scope: Scope = new Map([
      ["a", ref("base")],
      ["base", lit("/api/v2")],
    ]);
    const r = foldValue(concat(ref("a"), lit("/users")), scope);
    expect(r.text).toBe("/api/v2/users");
    expect(r.confidence).toBe("EXTRACTED");
  });

  it("renders a parameter ref as {name} and marks INFERRED", () => {
    const r = foldValue(concat(lit("/api/"), ref("id")), new Map(), {
      params: new Set(["id"]),
    });
    expect(r.text).toBe("/api/{id}");
    expect(r.confidence).toBe("INFERRED");
    expect(r.hadHole).toBe(true);
  });

  it("renders an env read as {env:NAME} by default and collapses on request", () => {
    const expr = concat(env("VITE_API"), lit("/api/x"));
    expect(foldValue(expr, new Map()).text).toBe("{env:VITE_API}/api/x");
    expect(foldValue(expr, new Map(), { envMode: "collapse" }).text).toBe("/api/x");
  });

  it("reduces an opaque runtime part to {} (or keeps it verbatim on request)", () => {
    const expr = concat(lit("/api/"), opaque("x.externalId"));
    expect(foldValue(expr, new Map()).text).toBe("/api/{}");
    expect(foldValue(expr, new Map(), { opaqueCall: "keep" }).text).toBe("/api/x.externalId");
  });

  it("keeps literal template fragments and holes for unresolvable pieces", () => {
    // `/api/${id}/x` where id is a closure ref not in scope → {}
    const r = foldValue(template(lit("/api/"), ref("id"), lit("/x")), new Map());
    expect(r.text).toBe("/api/{}/x");
    expect(r.hadHole).toBe(true);
  });

  it("fails a concat (null) when a piece is genuinely unresolvable via a cycle", () => {
    const scope: Scope = new Map([
      ["a", ref("b")],
      ["b", ref("a")],
    ]);
    const r = foldValue(concat(ref("a"), lit("/x")), scope);
    expect(r.text).toBeNull();
  });

  it("survives a cyclic ref inside a template by holing the cyclic piece", () => {
    const scope: Scope = new Map([
      ["a", ref("b")],
      ["b", ref("a")],
    ]);
    const r = foldValue(template(lit("/api/"), ref("a")), scope);
    expect(r.text).toBe("/api/{}");
  });

  it("downgrades to AMBIGUOUS on a conflicting (null) binding", () => {
    const scope: Scope = new Map([["base", null]]);
    const r = foldValue(concat(ref("base"), lit("/x")), scope);
    expect(r.text).toBe("{}/x");
    expect(r.confidence).toBe("AMBIGUOUS");
  });

  it("holes an unknown identifier rather than failing", () => {
    const r = foldValue(concat(ref("unknown"), lit("/x")), new Map());
    expect(r.text).toBe("{}/x");
    expect(r.confidence).toBe("INFERRED");
  });

  it("bounds a deep ref chain by maxDepth", () => {
    const scope = new Map<string, ValueExpr>();
    for (let i = 0; i < 40; i++) scope.set(`v${i}`, ref(`v${i + 1}`));
    scope.set("v40", lit("/deep"));
    const r = foldValue(ref("v0"), scope, { maxDepth: 8 });
    // Cut off before reaching the literal — a hole, not a crash.
    expect(r.text).toBe("{}");
    expect(r.hadHole).toBe(true);
  });
});

describe("splitTopLevel", () => {
  it("splits an arg list without breaking on separators inside strings/parens", () => {
    expect(splitTopLevel("'a, b', foo(x, y), 'v4'", ",")).toEqual([
      "'a, b'",
      " foo(x, y)",
      " 'v4'",
    ]);
  });

  it("splits a concat on top-level + only", () => {
    expect(splitTopLevel("'aktiviteter/' + x.externalId", "+")).toEqual([
      "'aktiviteter/' ",
      " x.externalId",
    ]);
  });
});

describe("unquote", () => {
  it("strips one matching layer of quotes/backticks", () => {
    expect(unquote("'x'")).toBe("x");
    expect(unquote('"y"')).toBe("y");
    expect(unquote("`z`")).toBe("z");
    expect(unquote("bare")).toBe("bare");
  });
});

describe("toAppRelativeUrl", () => {
  it("strips a leading {env:NAME} base and reports the env var", () => {
    expect(toAppRelativeUrl("{env:VITE_API}/api/x")).toEqual({ url: "/api/x", baseEnv: "VITE_API" });
  });

  it("leaves a literal absolute URL untouched (downstream treats it as external)", () => {
    expect(toAppRelativeUrl("https://api.example.com/v1/users")).toEqual({
      url: "https://api.example.com/v1/users",
    });
  });

  it("strips a leading unresolved {} base before an app-relative path", () => {
    expect(toAppRelativeUrl("{}/api/x")).toEqual({ url: "/api/x" });
  });

  it("leaves an interior {env:NAME} in place (the normalizer collapses it)", () => {
    expect(toAppRelativeUrl("/api/{env:REGION}/x")).toEqual({ url: "/api/{env:REGION}/x" });
  });
});
