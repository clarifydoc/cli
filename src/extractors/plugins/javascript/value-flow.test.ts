/**
 * Callable value flow in TypeScript/JavaScript, through the real per-file pipeline and the linker: a function value
 * through locals, parameters, `this` fields, factories, lists and maps to the call that runs it. Every case keeps a
 * same-named decoy a name tier would grab.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language = "typescript"): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "vf-js-"));
  const out = await mkdtemp(join(tmpdir(), "vf-js-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const flow = (links: SymbolLink[]): string[] =>
  links.filter((l) => l.strategy === "value-flow").map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort();

const decoy = ["export function save() { return 'decoy'; }", "export function onSave() { return 'decoy'; }", "export function handler() { return 'decoy'; }", ""].join("\n");

describe("value-flow (js): locals, parameters and wrappers", () => {
  const files = {
    "src/club.ts": ["export function saveClub() { return 1; }", ""].join("\n"),
    "src/decoys.ts": decoy,
    "src/runner.ts": ["export function run(cb: () => void) {", "  cb();", "}", ""].join("\n"),
    "src/page.ts": [
      "import { saveClub } from './club';",
      "import { run } from './runner';",
      "export function boot() {",
      "  const h = saveClub;",
      "  const g = h;",
      "  run(g);",
      "}",
      "",
    ].join("\n"),
  };
  it("reaches the function through two copies and a wrapper, never a namesake", async () => {
    const links = buildSymbolLinks(await analyzeAll(files));
    expect(flow(links)).toEqual(["run@2 cb -> src/club.ts::saveClub"]);
    expect(links.some((l) => l.callName === "cb" && l.targetFile === "src/decoys.ts")).toBe(false);
  });
});

describe("value-flow (js): fields", () => {
  const files = {
    "src/decoys.ts": decoy,
    "src/club.ts": [
      "export class Club {",
      "  onSave: (() => void) | null = null;",
      "  bound = this.reload.bind(this);",
      "  constructor() { this.onSave = this.save; }",
      "  save() { return 1; }",
      "  reload() { return 2; }",
      "  fire() { this.onSave?.(); }",
      "  again() { this.bound(); }",
      "}",
      "",
    ].join("\n"),
  };
  it("stores through `this` (assignment and a bound field initializer) and invokes in another method", async () => {
    const links = buildSymbolLinks(await analyzeAll(files));
    expect(flow(links)).toEqual(["Club.again@8 this.bound -> src/club.ts::Club.reload", "Club.fire@7 this.onSave -> src/club.ts::Club.save"]);
  });
});

describe("value-flow (js): factories", () => {
  const files = {
    "src/decoys.ts": decoy,
    "src/club.ts": [
      "function sellPlayer() { return 1; }",
      "export function make() { return sellPlayer; }",
      "export function use() {",
      "  const f = make();",
      "  f();",
      "}",
      "",
    ].join("\n"),
  };
  it("returns a function from a factory and runs it in the caller", async () => {
    expect(flow(buildSymbolLinks(await analyzeAll(files)))).toEqual(["use@5 f -> src/club.ts::sellPlayer"]);
  });
});

describe("value-flow (js): lists and maps", () => {
  const files = {
    "src/decoys.ts": decoy,
    "src/club.ts": [
      "function save() { return 1; }",
      "function load() { return 2; }",
      "export function fire(kind: string) {",
      "  const handlers: Array<() => void> = [];",
      "  handlers.push(save);",
      "  for (const h of handlers) h();",
      "  let m = { load, size: 1 };",
      "  m[kind]();",
      "  m.load();",
      "}",
      "export function each() {",
      "  const hs = [];",
      "  hs.push(load);",
      "  hs.forEach((h) => h());",
      "}",
      "",
    ].join("\n"),
  };
  it("invokes a pushed handler by element, a map by key, and a forEach callback", async () => {
    const out = flow(buildSymbolLinks(await analyzeAll(files)));
    expect(out).toContain("fire@6 h -> src/club.ts::save");
    expect(out).toContain("fire@8 m[] -> src/club.ts::load");
    expect(out).toContain("each@14 h -> src/club.ts::load");
    expect(out.some((l) => l.includes("src/decoys.ts"))).toBe(false);
  });
});

describe("value-flow (js): call and apply", () => {
  const files = {
    "src/decoys.ts": decoy,
    "src/club.ts": [
      "function save() { return 1; }",
      "function runIt(cb: () => void) { cb.call(null); }",
      "export function go() { runIt(save); }",
      "",
    ].join("\n"),
  };
  it("runs the function a receiver of .call holds", async () => {
    expect(flow(buildSymbolLinks(await analyzeAll(files)))).toEqual(["runIt@2 cb.call -> src/club.ts::save"]);
  });
});

describe("value-flow (js): module state", () => {
  const files = {
    "src/decoys.ts": decoy,
    "src/club.ts": [
      "function save() { return 1; }",
      "let current: (() => void) | null = null;",
      "export function register(fn: () => void) { current = fn; }",
      "export function boot() { register(save); }",
      "export function fire() { current?.(); }",
      "",
    ].join("\n"),
  };
  it("holds a function in a module variable a function assigns and another runs", async () => {
    expect(flow(buildSymbolLinks(await analyzeAll(files)))).toEqual(["fire@5 current -> src/club.ts::save"]);
  });
});

describe("value-flow (js): a member of a local object and a held callback", () => {
  const files = {
    "src/decoys.ts": [decoy, "export function reload() { return 'decoy'; }", "export function load() { return 'decoy'; }", ""].join("\n"),
    "src/club.ts": [
      "function load() { return 1; }",
      "function reload() { return 2; }",
      "export function keyed(kind: string) {",
      "  let m = { load, size: 1 };",
      "  m.load();",
      "  m['load']();",
      "}",
      "export function arm(toast: { action?: () => void }) {",
      "  toast.action = () => reload();",
      "  toast.action();",
      "}",
      "",
    ].join("\n"),
  };
  it("runs the member a function stores itself, by key or by a held pseudo-name", async () => {
    const out = flow(buildSymbolLinks(await analyzeAll(files)));
    // One link per call name and target, however many lines make the call.
    expect(out.filter((l) => l.startsWith("keyed@") && l.endsWith("m.load -> src/club.ts::load") || l.includes(" m.load -> src/club.ts::load")).length).toBe(1);
    expect(out.some((l) => l.startsWith("arm@10 toast.action -> src/club.ts::<toast.action@9>"))).toBe(true);
    expect(out.some((l) => l.includes("src/decoys.ts"))).toBe(false);
  });
});

describe("value-flow (js): a toast action stored by a store method and read back elsewhere", () => {
  const files = {
    "src/decoys.ts": [decoy, "export function onClick() { return 'decoy'; }", ""].join("\n"),
    "src/toast.ts": [
      "export function undo() { return 1; }",
      "export class ToastStore {",
      "  toast: { action?: { onClick: () => void } } = {};",
      "  setToast(opts: { action?: { onClick: () => void } }) { this.toast.action = opts.action; }",
      "  fire() { this.toast.action?.onClick(); }",
      "}",
      "export function open(store: ToastStore) { store.setToast({ action: { onClick: undo } }); }",
      "",
    ].join("\n"),
  };
  it("does not guess: the object is passed whole, so no link is stated (and no namesake is taken)", async () => {
    const links = buildSymbolLinks(await analyzeAll(files));
    expect(flow(links)).toEqual([]);
    expect(links.some((l) => l.callName.endsWith("onClick") && l.targetFile === "src/decoys.ts")).toBe(false);
  });
});

describe("value-flow (js): nothing held", () => {
  it("states no link for a parameter nothing passes a function to", async () => {
    const links = buildSymbolLinks(await analyzeAll({
      "src/decoys.ts": decoy,
      "src/club.ts": ["export function run(handler: () => void) { handler(); }", "export function go() { run(() => 1); }", ""].join("\n"),
    }));
    expect(flow(links)).toEqual([]);
  });
});
