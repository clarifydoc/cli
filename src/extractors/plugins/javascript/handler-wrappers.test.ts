import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";

/**
 * A handler handed to a wrapper that is no identity (`withAuth(async (req, res) => …)`) and bound to a module-level
 * name is that name's function: its calls are the binding's, never the module's `<setup>`.
 */
const SRC = `import { listClubs, listCars, listPlayers } from "./db";
import { withAuth } from "./auth";
const getClubs = withAuth(async (req, res) => { res.json(await listClubs()); });
export const GET = withAuth(async (req) => Response.json(await listCars()));
export const makeStore = create((set) => ({ players: listPlayers() }));
const plain = withAuth((req, res) => { listPlayers(); });
router.get("/players", withAuth(async (req, res) => { res.json(await listPlayers()); }));`;

describe("non-identity handler wrappers", () => {
  it("names the binding's function and keeps the handler's calls out of <setup>", async () => {
    const tree = await parseSource(SRC, "typescript" as never, "clubs.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, SRC);
    const names = fns.map((f) => f.name);
    expect(names).toContain("getClubs");
    expect(names).toContain("GET");
    expect(fns.find((f) => f.name === "getClubs")!.calls.map((c) => c.name)).toEqual(["listClubs"]);
    const setup = extractTopLevelCalls(tree, "typescript" as never).map((c) => c.name);
    expect(setup).toContain("withAuth");
    // The handlers' own calls are not the module's.
    expect(setup).not.toContain("listClubs");
    expect(setup).not.toContain("listCars");
    // A factory object and a non-async expression body are no handler: still the module's.
    expect(names).not.toContain("makeStore");
    expect(names).not.toContain("plain");
  });
});
