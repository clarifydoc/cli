import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A call on a receiver the caller constructed (`const league: League = new League()`, or untyped) names a member of
 * that class or nothing. It never lands on the class itself through the `factory-via` fallback, and a same-named
 * member of an unrelated class is never the target. (real-repo FP: a typed construction linked to its class.)
 */
describe("calls on a constructed receiver", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ctor-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web"}');
    await file("src/league.ts", "export class League {\n  relegateClub(id: string) { return id; }\n}\n");
    await file("src/garage.ts", "export class Garage {\n  relegateClub(id: string) { return id; }\n  tow() {}\n  promoteClub(id: string) { return id; }\n}\n");
    await file(
      "src/use.ts",
      [
        'import { League } from "./league";',
        'import { Garage } from "./garage";',
        'export function typed() { const league: League = new League(); league.relegateClub("a"); league.promoteClub("b"); }',
        'export function untyped() { const league = new League(); league.relegateClub("a"); league.promoteClub("b"); }',
        'export function other() { const g = new Garage(); g.relegateClub("a"); }',
        "",
      ].join("\n"),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a declared member to its own class, a missing one to nothing, never the class", { timeout: 60_000 }, async () => {
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "src/use.ts" && l.relation !== "reference");
    const key = (l: (typeof links)[number]) => `${l.sourceSymbol}:${l.callName}->${l.targetFile}#${l.targetSymbol}`;
    const got = links.filter((l) => /\.(relegateClub|promoteClub)$/.test(l.callName)).map(key).sort();
    expect(got).toEqual([
      "other:g.relegateClub->src/garage.ts#Garage.relegateClub",
      "typed:league.relegateClub->src/league.ts#League.relegateClub",
      "untyped:league.relegateClub->src/league.ts#League.relegateClub",
    ]);
    expect(links.filter((l) => l.strategy === "factory-via")).toEqual([]);
  });
});
