import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { classifyCalls, extractTopLevelCalls } from "../../shared/call-graph.js";
import { extractInteractiveElements } from "./interactive-elements.js";
import { JavaScriptImportExportExtractor } from "./imports-exports.js";
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

describe("wrapped components (memo, observer, forwardRef)", () => {
  it("names the function a component wrapper is handed, keeps its calls out of <setup>, and gives the default export its name", async () => {
    const src = `import React, { memo, forwardRef } from "react";
import { observer } from "mobx-react-lite";
export default memo(function FancyBadge() {
  axios.get("/api/matches/latest");
  return <Card />;
});
export const Tyre = observer(() => <Card />);
export const Wheel = React.memo(function Wheel() { return loadWheels(); });
export const Spoke = React.forwardRef((props, ref) => loadSpokes(ref));
export const Goal = memo(forwardRef(function Goal(props, ref) { return loadGoals(ref); }));`;
    const tree = await parse(src, "FancyBadge.tsx");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const calls = (name: string) => fns.find((f) => f.name === name)?.calls.map((c) => c.name);
    expect(calls("FancyBadge")).toEqual(["axios.get", "Card"]);
    expect(fns.find((f) => f.name === "FancyBadge")!.isExported).toBe(true);
    expect(calls("Tyre")).toEqual(["Card"]);
    expect(calls("Wheel")).toEqual(["loadWheels"]);
    expect(calls("Spoke")).toEqual(["loadSpokes"]);
    expect(calls("Goal")).toEqual(["loadGoals"]);
    // The module's top level only calls the wrappers.
    const top = extractTopLevelCalls(tree, "typescript").map((c) => c.name);
    expect(top).not.toContain("axios.get");
    expect(top).not.toContain("Card");

    const exports = new JavaScriptImportExportExtractor().extractExports(tree, src);
    expect(exports.find((e) => e.name === "default")?.sourceName).toBe("FancyBadge");
  });

  it("names a default export by the component a wrapper is handed, and leaves an anonymous one to <setup>", async () => {
    const named = `import { observer } from "mobx-react-lite";
function Garage() { return load(); }
export default observer(Garage);`;
    const exports = new JavaScriptImportExportExtractor().extractExports(await parse(named, "Garage.tsx"), named);
    expect(exports.find((e) => e.name === "default")?.sourceName).toBe("Garage");

    const anonymous = `import { observer } from "mobx-react-lite";
export default observer(() => { axios.get("/api/garages"); return null; });`;
    const tree = await parse(anonymous, "Garage.tsx");
    expect(new JavaScriptExtractor().extractFunctions(tree, anonymous).map((f) => f.name)).toEqual([]);
    expect(extractTopLevelCalls(tree, "typescript").map((c) => c.name)).toContain("axios.get");
    expect(new JavaScriptImportExportExtractor().extractExports(tree, anonymous).find((e) => e.name === "default")?.sourceName).toBeUndefined();
  });
});

describe("a function's own require", () => {
  it("binds a destructured or member require inside a function to the module's members, not the whole module", async () => {
    const src = `function endSeason() {
  const { promoteClub: promote, saveClub } = require("./clubs");
  const relegate = require("./clubs").relegateClub;
  const fixtures = require("./fixtures");
  promote(1);
  saveClub({});
  relegate(3);
  fixtures.reschedule();
}`;
    const tree = await parse(src, "season.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const imports = new JavaScriptImportExportExtractor().extractImports(tree, src);
    const aliases = extractJsVariableAliases(tree, imports);
    const calls = classifyCalls(fns[0]!.calls, imports, "javascript", aliases, new Set(["endSeason"]), new Set());
    expect(calls.filter((c) => c.name !== "require").map((c) => `${c.name}:${c.kind}:${c.target}:${c.member ?? ""}`)).toEqual([
      "promote:cross-file:./clubs:promoteClub",
      "saveClub:cross-file:./clubs:saveClub",
      "relegate:cross-file:./clubs:relegateClub",
      // The whole module bound by name keeps the binding it had.
      "fixtures.reschedule:internal:null:",
    ]);
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
    // A destructured member keeps its key, renamed or not: it is part of the result, not the whole of it.
    expect(aliases.get("addToGarage")).toEqual({ source: "../context/AppContext", factory: "useAppContext", member: "addToGarage" });
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
    expect(aliases.get("park")).toEqual({ source: "", factory: "useGarage", member: "park" });
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
