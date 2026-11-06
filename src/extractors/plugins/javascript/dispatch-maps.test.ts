import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze as analyzeProject } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
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

  it("keeps a call of a key the map holds though the key is a noise word, and drops it on any other receiver", async () => {
    const code = `function sendClub(c) { return c; }
const ACTIONS = { send: sendClub, find: sendClub };
export function run(club, list) {
  list.find(club);
  ACTIONS.other(club);
  ACTIONS.find(club);
  return ACTIONS.send(club);
}`;
    const tree = await parseSource(code, "typescript" as never, "run.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, code);
    expect(shown(fns.find((f) => f.name === "run")!.calls)).toEqual(["ACTIONS.other", "ACTIONS.find", "ACTIONS.send"]);
  });
});

describe("a noise-named key of an imported map", () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "league-web", dependencies: {} }),
    "src/actions.js": `import { mapClub, filterClub } from './clubs';
export const ACTIONS = { map: mapClub, filter: filterClub };`,
    "src/lists.js": `export const LISTS = [1, 2, 3];
export const HANDLERS = { map: 1, filter: 2 };`,
    "src/clubs.js": `export function mapClub(c) { return c; }
export function filterClub(c) { return c; }
export function map(c) { return c; }`,
    "src/api.js": `class ClubAPI { filter(q) { return q; } }
export default new ClubAPI();`,
    "src/run.js": `import { ACTIONS } from './actions';
import ClubAPI from './api';
import { LISTS, HANDLERS } from './lists';
import _ from 'lodash';
export function runMap(club) { return ACTIONS.map(club); }
export function runFilter(club) { return ACTIONS.filter(club); }
export function runList() { return LISTS.map((x) => x); }
export function runHandlers() { return HANDLERS.map(1); }
export function runLodash(xs) { return _.map(xs, (x) => x); }
export function runApi(q) { return ClubAPI.filter(q); }`,
  };

  it("links `ACTIONS.map` through the object literal the exporting file declares, an imported instance's `filter` as any member call, and no array or package's `.map`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-imported-map-"));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyzeProject({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const rows = summary.symbolLinks
      .filter((l) => l.sourceFile === "src/run.js" && l.strategy !== "reference")
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`)
      .sort();
    expect(rows).toEqual([
      "runApi -ClubAPI.filter-> src/api.js#ClubAPI.filter",
      "runFilter -ACTIONS.filter-> src/clubs.js#filterClub",
      "runMap -ACTIONS.map-> src/clubs.js#mapClub",
    ]);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);
});
