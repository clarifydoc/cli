import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { classifyCalls } from "../../shared/call-graph.js";
import { extractInteractiveElements } from "./interactive-elements.js";
import type { ImportInfo } from "../../../types/analysis.js";

/**
 * The frontend half of a click→data-model trace, on the dominant React/Vue
 * shapes (greencart + photo-booth corpus): nested const-arrow handlers,
 * destructured composable/context members, inline anonymous JSX handlers.
 * Each of these was a hard break — the handler or its calls simply didn't
 * exist in the graph.
 */

const IMPORTS: ImportInfo[] = [
  { source: "../context/AppContext", specifiers: ["useAppContext"], line: 1 } as unknown as ImportInfo,
];

async function parse(src: string, file = "App.tsx") {
  return parseSource(src, "typescript" as any, file);
}

describe("nested named function extraction (React handler idiom)", () => {
  it("extracts a const-arrow handler defined INSIDE a component", async () => {
    const src = `export function Login() {
  const onSubmitHandler = async (event) => {
    event.preventDefault();
    await submit();
  };
  return <form onSubmit={onSubmitHandler} />;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const names = fns.map((f) => f.name);
    expect(names).toContain("Login");
    expect(names).toContain("onSubmitHandler");
    const handler = fns.find((f) => f.name === "onSubmitHandler")!;
    expect(handler.calls.some((c) => c.name === "submit")).toBe(true);
  });

  it("extracts a named binding inside an anonymous effect callback", async () => {
    const src = `export function List() {
  useEffect(() => {
    const load = async () => { await fetchAll(); };
    load();
  }, []);
  return null;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    expect(fns.map((f) => f.name)).toContain("load");
  });

  it("still does NOT extract anonymous callbacks as functions", async () => {
    const src = `export function C() {
  const items = data.map((x) => x.id);
  return items;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    expect(fns.map((f) => f.name)).toEqual(["C"]);
  });
});

describe("anonymous-arrow call attribution", () => {
  it("attributes a call inside an inline JSX handler to the component", async () => {
    const src = `export function ProductCard({ product }) {
  const { addToCart } = useAppContext();
  return <button onClick={() => addToCart(product._id)}>Add</button>;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const card = fns.find((f) => f.name === "ProductCard")!;
    expect(card.calls.some((c) => c.name === "addToCart")).toBe(true);
  });

  it("does NOT pull a NAMED nested arrow's calls into the parent", async () => {
    const src = `export function Login() {
  const onSubmitHandler = async () => { await submit(); };
  return <form onSubmit={onSubmitHandler} />;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const login = fns.find((f) => f.name === "Login")!;
    expect(login.calls.some((c) => c.name === "submit")).toBe(false);
  });
});

describe("destructured factory-member aliases", () => {
  it("maps destructured members to the factory's module (any scope)", async () => {
    const src = `import { useAppContext } from "../context/AppContext";
export function Cart() {
  const { addToCart, removeFromCart: drop } = useAppContext();
  return null;
}`;
    const tree = await parse(src);
    const aliases = extractJsVariableAliases(tree, IMPORTS);
    expect(aliases.get("addToCart")).toEqual({ source: "../context/AppContext", factory: "useAppContext" });
    expect(aliases.get("drop")).toEqual({ source: "../context/AppContext", factory: "useAppContext" }); // renamed binding
  });

  it("drops a name bound to DIFFERENT sources (ambiguous) rather than guessing", async () => {
    const imports = [
      { source: "./a", specifiers: ["useA"], line: 1 },
      { source: "./b", specifiers: ["useB"], line: 2 },
    ] as unknown as ImportInfo[];
    const src = `import { useA } from "./a";
import { useB } from "./b";
function one() { const { save } = useA(); }
function two() { const { save } = useB(); }`;
    const tree = await parse(src, "x.ts");
    const aliases = extractJsVariableAliases(tree, imports);
    expect(aliases.has("save")).toBe(false);
  });

  it("classifies a BARE destructured-member call as cross-file into the factory module", () => {
    const aliases = new Map([["addToCart", "../context/AppContext"]]);
    const calls = [{ name: "addToCart", kind: "internal" as const, target: null, line: 5 }];
    classifyCalls(calls, [], "typescript", aliases);
    expect(calls[0]).toMatchObject({ kind: "cross-file", target: "../context/AppContext", confidence: "INFERRED" });
  });

  it("records the factory on the call (via) so tanstack mutate() can route through it", () => {
    const aliases = new Map([
      ["licenseMutation", { source: "./LicenseQueries", factory: "useAddLicenseMutation" }],
    ]);
    const calls = [{ name: "licenseMutation.mutateAsync", kind: "internal" as const, target: null, line: 9 }];
    classifyCalls(calls, [], "typescript", aliases);
    expect(calls[0]).toMatchObject({
      kind: "cross-file",
      target: "./LicenseQueries",
      via: "useAddLicenseMutation",
    });
  });
});

describe("JSX handler-name extraction (jsx_attribute has no `value` field)", () => {
  it("captures onClick={handleClick} and onClick={() => save(id)}", async () => {
    const src = `export function C() {
  return <div>
    <button onClick={handleClick}>a</button>
    <button onClick={() => save(item.id)}>b</button>
  </div>;
}`;
    const tree = await parse(src);
    const els = extractInteractiveElements(tree, src, "typescript" as any);
    const handlers = els.map((e) => e.handler);
    expect(handlers).toContain("handleClick");
    expect(handlers).toContain("save");
  });
});
