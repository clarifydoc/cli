/**
 * A call on a value typed by an object type alias reaches the alias's member, as for an interface: method
 * signatures, function-typed properties, a generic alias, an intersection with a named type, a Readonly wrapper.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "package.json": `{"name":"club"}`,
  "src/api.ts": `export type ClubApi = { sign(p: string): void; kick: (p: string) => void };
export type Repo<T> = { find(id: string): T };
export interface Scouting { scout(): void }
export type League = Scouting & { relegate(): void };
export type Port = Readonly<{ read(): number }>;
export type Choice = { pick(): void } | { drop(): void };
export type Plain = string;
`,
  "src/shadow.ts": `type Readonly<T> = { wrapped: T };
export type Fake = Readonly<{ whistle(): void }>;
`,
  "src/decoy.ts": `export class Other { sign() {} }\n`,
  "src/dom.ts": `export type Assignable = { nodeName: string; getAttribute: (name: string) => string | null };\n`,
  "src/page.ts": `import { Assignable } from "./dom";
export function wire(el: HTMLElement, box, a: Assignable) {
  el.getAttribute("data-club");
  box.getAttribute("data-car");
  a.getAttribute("data-match");
}
`,
  "src/main.ts": `import { ClubApi, Repo, League, Port, Choice } from "./api";
import { Fake } from "./shadow";
import { Other } from "./decoy";
export function run(a: ClubApi, o: Other, r: Repo<string>, l: League, p: Port, c: Choice, f: Fake) {
  a.sign("x");
  a.kick("y");
  o.sign("z");
  r.find("1");
  l.relegate();
  l.scout();
  p.read();
  f.whistle();
}
`,
};

describe("object type alias members", () => {
  let dir: string;
  let s: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-type-alias-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "p", path)), { recursive: true });
      await writeFile(join(dir, "p", path), text);
    }
    await analyze({ projectRoot: join(dir, "p"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    s = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links each call to the alias member, the decoy to its own class, and a Readonly declared in the same file (the only place a shadow is seen) to nothing", () => {
    const links = s.symbolLinks
      .filter((l) => l.sourceFile === "src/main.ts" && l.sourceSymbol !== "(reference)" && l.relation !== "reference")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "a.kick -> src/api.ts::ClubApi.kick",
      "a.sign -> src/api.ts::ClubApi.sign",
      "l.relegate -> src/api.ts::League.relegate",
      "l.scout -> src/api.ts::Scouting.scout",
      "o.sign -> src/decoy.ts::Other.sign",
      "p.read -> src/api.ts::Port.read",
      "r.find -> src/api.ts::Repo.find",
    ]);
  });

  it("leaves a DOM member on an element the project cannot type alone, while a receiver typed by the alias links (real-repo FP)", () => {
    const links = s.symbolLinks
      .filter((l) => l.sourceFile === "src/page.ts" && l.relation !== "reference")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(["a.getAttribute -> src/dom.ts::Assignable.getAttribute"]);
  });
});
