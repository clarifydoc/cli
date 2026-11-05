import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { collectionElement } from "./element-types.js";

describe("collectionElement", () => {
  it("reads the element of an array, set, iterable or map type", () => {
    expect(collectionElement("Club[]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("readonly Club[]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("Array<Club> | undefined")).toEqual({ element: "Club", map: false });
    expect(collectionElement("ReadonlyArray<League.Club>")).toEqual({ element: "League.Club", map: false });
    expect(collectionElement("Set<Club>")).toEqual({ element: "Club", map: false });
    expect(collectionElement("Map<string, Club>")).toEqual({ element: "Club", map: true });
    expect(collectionElement("(Club | Decoy)[]")).toBeNull();
    expect(collectionElement("string[]")).toBeNull();
    expect(collectionElement("Club")).toBeNull();
  });
});

describe("TypeScript loop variables and callback parameters take the collection's element type", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "package.json": '{"name":"league","version":"1.0.0"}',
    "src/club.ts": `export class Club {
  save(): void {}
  rank(): number { return 1 }
}
export class Decoy {
  save(): void {}
  rank(): number { return 2 }
}
`,
    "src/service.ts": `import { Club, Decoy } from "./club";

export function persistLoop(clubs: Club[]) {
  for (const c of clubs) {
    c.save();
  }
}

export function persistCallback(clubs: Array<Club>) {
  clubs.forEach((c) => c.save());
}

export function persistChain(clubs: ReadonlyArray<Club>) {
  clubs.filter((x) => x.rank() > 1).map(function (y) { return y.rank(); });
}

export function persistMap(byId: Map<string, Club>) {
  for (const [id, v] of byId) { v.save(); }
  for (const w of byId.values()) { w.rank(); }
}

export function persistLocal() {
  const set: Set<Club> = new Set();
  for (const s of set) s.save();
}

export function mixed(clubs: Club[], decoys: Decoy[]) {
  for (const p of clubs) p.save();
  for (const p of decoys) p.save();
}

export function notACollection(names: string[]) {
  for (const n of names) n.save();
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ts-elements-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types a for…of variable and a callback parameter", () => {
    expect(target("persistLoop", "c.save")).toEqual(["Club.save:injection"]);
    expect(target("persistCallback", "c.save")).toEqual(["Club.save:injection"]);
  });

  it("follows a chain that keeps the elements", () => {
    expect(target("persistChain", "x.rank")).toEqual(["Club.rank:injection"]);
    expect(target("persistChain", "y.rank")).toEqual(["Club.rank:injection"]);
  });

  it("types the value of a map entry and a map's values", () => {
    expect(target("persistMap", "v.save")).toEqual(["Club.save:injection"]);
    expect(target("persistMap", "w.rank")).toEqual(["Club.rank:injection"]);
  });

  it("types a loop over an annotated local collection", () => {
    expect(target("persistLocal", "s.save")).toEqual(["Club.save:injection"]);
  });

  it("types nothing where one name is bound to two element types, or the elements are no class", () => {
    expect(target("mixed", "p.save")).toEqual([]);
    expect(target("notACollection", "n.save")).toEqual([]);
  });
});
