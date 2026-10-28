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

describe("functions behind identity wrappers (useCallback, memo, forwardRef, debounce)", () => {
  it("names the function a wrapper returns, and links a bare call to it rather than to React", async () => {
    const imports = [{ source: "react", specifiers: ["useCallback", "memo"], line: 1 }] as unknown as ImportInfo[];
    const src = `import { useCallback, memo } from "react";
export function Selector() {
  const fetchOrganizations = useCallback(async (q) => {
    await load(q);
  }, []);
  const onSearch = debounce((q) => fetchOrganizations(q), 300);
  useEffect(() => { fetchOrganizations(); }, [fetchOrganizations]);
  return null;
}
export const Row = memo(function Row(props) { return render(props); });
export const Lazy = useMemo(() => compute(), []);`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(["Selector", "fetchOrganizations", "onSearch", "Row"]));
    expect(fns.map((f) => f.name)).not.toContain("Lazy");
    expect(fns.find((f) => f.name === "fetchOrganizations")!.calls.map((c) => c.name)).toEqual(["load"]);

    const aliases = extractJsVariableAliases(tree, imports);
    const local = new Set(fns.map((f) => f.name));
    const selector = fns.find((f) => f.name === "Selector")!;
    const call = classifyCalls(selector.calls, imports, "typescript", aliases, local).find((c) => c.name === "fetchOrganizations")!;
    expect([call.kind, call.target]).toEqual(["internal", null]);
  });
});

describe("Redux Toolkit thunks", () => {
  it("names a createAsyncThunk binding after its payload creator, so dispatching it reaches its calls", async () => {
    const src = `import { createAsyncThunk } from "@reduxjs/toolkit";
export const fetchGames = createAsyncThunk("games/fetch", async () => {
  const res = await axios.get("/api/games");
  return res.data;
});
export const addGame = createAsyncThunk("games/add", async (title, { rejectWithValue }) => save(title), { condition: () => true });`;
    const tree = await parse(src, "gamesSlice.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    expect(fns.find((f) => f.name === "fetchGames")!.calls.map((c) => c.name)).toEqual(["axios.get"]);
    // The payload creator is the last FUNCTION argument, not the options object after it.
    expect(fns.find((f) => f.name === "addGame")!.calls.map((c) => c.name)).toEqual(["save"]);
  });
});

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
    const src = `export function PartCard({ part }) {
  const { addToGarage } = useAppContext();
  return <button onClick={() => addToGarage(part._id)}>Add</button>;
}`;
    const tree = await parse(src);
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const card = fns.find((f) => f.name === "PartCard")!;
    expect(card.calls.some((c) => c.name === "addToGarage")).toBe(true);
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
export function Garage() {
  const { addToGarage, removeFromGarage: drop } = useAppContext();
  return null;
}`;
    const tree = await parse(src);
    const aliases = extractJsVariableAliases(tree, IMPORTS);
    expect(aliases.get("addToGarage")).toEqual({ source: "../context/AppContext", factory: "useAppContext" });
    expect(aliases.get("drop")).toEqual({ source: "../context/AppContext", factory: "useAppContext", member: "removeFromGarage" }); // renamed binding
  });

  it("keeps the factory of an unimported call with no source, never over an imported one (real-repo FP)", async () => {
    const imports = [{ source: "./laps", specifiers: ["useLaps"], line: 1 }] as unknown as ImportInfo[];
    const src = `import { useLaps } from "./laps";
const { park } = useGarage();
function one() { const query = buildQuery(); return query; }
function two() { const query = useLaps(); query.refetch(); }`;
    const tree = await parse(src, "x.ts");
    const aliases = extractJsVariableAliases(tree, imports);
    expect(aliases.get("park")).toEqual({ source: "", factory: "useGarage" });
    expect(aliases.get("query")).toEqual({ source: "./laps", factory: "useLaps" });
  });

  it("binds a prop typed as what a factory returns to that factory, through a type-only import (real-repo FP)", async () => {
    const imports = [{ source: "~/composables/use-fixtures", specifiers: ["useFixtures"], line: 1, isType: true }] as unknown as ImportInfo[];
    const src = `import type { useFixtures } from "~/composables/use-fixtures";
interface Props {
  actions: ReturnType<typeof useFixtures>["actions"];
  standings: ReturnType<typeof useStandings>;
  day: Date;
}`;
    const tree = await parse(src, "x.ts");
    const aliases = extractJsVariableAliases(tree, imports);
    expect(aliases.get("actions")).toEqual({ source: "~/composables/use-fixtures", factory: "useFixtures" });
    expect(aliases.get("standings")).toEqual({ source: "", factory: "useStandings" });
    expect(aliases.has("day")).toBe(false);
  });

  it("binds a typed prop read off the props object, and the one factory a conditional initializer calls (real-repo FP)", async () => {
    const imports = [
      { source: "~/composables/use-fixtures", specifiers: ["useFixtures"], line: 1, isType: true },
      { source: "~/composables/store", specifiers: ["useKitStore", "useClubStore"], line: 2 },
    ] as unknown as ImportInfo[];
    const src = `import type { useFixtures } from "~/composables/use-fixtures";
import { useKitStore, useClubStore } from "~/composables/store";
const props = defineProps<{
  actions: ReturnType<typeof useFixtures>["actions"];
}>();
const kitStore = isOwnClub.value ? useKitStore() : null;
const either = home ? useClubStore() : useKitStore();
function postpone(match) { props.actions.updateOne(match); kitStore.actions.updateOne(match); }`;
    const tree = await parse(src, "x.ts");
    const aliases = extractJsVariableAliases(tree, imports);
    expect(aliases.get("props.actions")).toEqual({ source: "~/composables/use-fixtures", factory: "useFixtures" });
    expect(aliases.get("kitStore")).toEqual({ source: "~/composables/store", factory: "useKitStore" });
    // Two factories, chosen at run time: no binding.
    expect(aliases.has("either")).toBe(false);
    const calls = classifyCalls([{ name: "props.actions.updateOne", kind: "internal", target: null, line: 8 }], imports, "typescript", aliases);
    expect(calls[0]).toMatchObject({ kind: "cross-file", target: "~/composables/use-fixtures", via: "useFixtures" });
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
    const aliases = new Map([["addToGarage", "../context/AppContext"]]);
    const calls = [{ name: "addToGarage", kind: "internal" as const, target: null, line: 5 }];
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
