import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "maps-"));
  await writeFile(join(root, "actions.ts"), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, "actions.ts"), relativePath: "actions.ts", language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "maps-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

/**
 * A dispatch map — `const ACTIONS = { save: saveClub }`, then `ACTIONS[kind]()` or
 * `ACTIONS.save()` — hands its values on under their keys, from the scope declaring it.
 */
const shown = (calls: Array<{ name: string; passed?: string; returnedAs?: string }>) =>
  calls.map((c) => (c.passed ? `${c.name}[${c.passed}:${c.returnedAs}]` : c.name));

describe("dispatch maps", () => {
  const src = `import { loadMatches } from "./matches";
function saveClub(c) { return c; }
const LIMIT = 3;
const ACTIONS = { save: saveClub, list: loadMatches, store: saveClub, remove } as const;
const SETTINGS = { limit: LIMIT, name: "league" };
const NESTED = { clubs: { save: saveClub } };
export function run(kind) {
  return ACTIONS[kind]();
}
export function runSave() {
  ACTIONS["list"]();
  return ACTIONS.save();
}
export function runLocal(kind, onSave) {
  const HANDLERS = { save: onSave, promote: saveClub };
  return HANDLERS[kind]();
}
export function runArray(i) {
  return LISTS[i]();
}`;

  it("hands a module-level map's values on from <setup>, keyed by map and key; data objects are no map", async () => {
    const tree = await parseSource(src, "typescript" as never, "actions.ts");
    expect(shown(extractTopLevelCalls(tree, "typescript" as never))).toEqual([
      "saveClub[property:ACTIONS.save]",
      "loadMatches[property:ACTIONS.list]",
      "saveClub[property:ACTIONS.store]",
      "remove[property:ACTIONS.remove]",
    ]);
  });

  it("names a call through a map, and hands on a function-scoped map's values but not its parameters", async () => {
    const tree = await parseSource(src, "typescript" as never, "actions.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const calls = (name: string) => shown(fns.find((f) => f.name === name)!.calls);
    expect(calls("run")).toEqual(["ACTIONS[]"]);
    expect(calls("runSave")).toEqual(["ACTIONS.list", "ACTIONS.save"]);
    expect(calls("runLocal")).toEqual(["saveClub[property:HANDLERS.promote]", "HANDLERS[]"]);
    // An array element is no map call.
    expect(calls("runArray")).toEqual([]);
  });

  it("reads a call through a map of the file's own functions as the file's, whatever its key says", async () => {
    const a = await analyze(`import { loadMatches } from "./matches";
import axios from "axios";
function saveClub(c) { return c; }
const ACTIONS = { save: saveClub, create: loadMatches };
const http = { get: axios.get };
export function runSave() { ACTIONS.save(); ACTIONS.create(); return http.get("/api/matches"); }`);
    const kinds = a.functions.find((f) => f.name === "runSave")!.calls.map((c) => `${c.name}:${c.kind}`);
    // A map of a library's members (\`http.get\`) keeps what its name says.
    expect(kinds).toEqual(["ACTIONS.save:internal", "ACTIONS.create:internal", "http.get:api-call"]);
  });

  it("names a call through an imported name as a map call, and an array of the file as none", async () => {
    const code = `import { ACTIONS, type Kind as Shape } from "./actions";
import Registry from "./registry";
import * as Garage from "./garage";
export function run(kind, club) { return ACTIONS[kind](club); }
export function runList(club) { return ACTIONS["list"](club); }
export function runDefault(kind) { return Registry[kind](); }
export function runSpace(kind) { return Garage[kind](); }
export function runLocal(i) { return LOCAL[i](); }`;
    const tree = await parseSource(code, "typescript" as never, "run.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, code);
    const calls = (name: string) => shown(fns.find((f) => f.name === name)!.calls);
    expect(calls("run")).toEqual(["ACTIONS[]"]);
    expect(calls("runList")).toEqual(["ACTIONS.list"]);
    expect(calls("runDefault")).toEqual(["Registry[]"]);
    expect(calls("runSpace")).toEqual([]);
    expect(calls("runLocal")).toEqual([]);
  });
});
