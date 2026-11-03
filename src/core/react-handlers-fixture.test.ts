import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * `test-fixtures/sample-react-handlers`: React handlers handed on by name, labelled by hand from the
 * source. Each page's button must reach the Express route it ends at (and so `clubs`/`matches`):
 *
 *   BarePage  onClick={saveClub}            imported function       → POST /api/clubs
 *   NsPage    onClick={clubs.loadLatest}    namespace member        → GET /api/matches/latest
 *   PropPage  <Toolbar onRefresh={loadLatest}/>  prop               → GET /api/matches/latest
 *   HookPage  const { save, latest } = useClubActions()  hook's returned functions (`latest: loadLatest`)
 *   ListPage  const [rows, refresh] = useMatches()       hook's returned array, by position
 *   MapPage   const ACTIONS = { save: saveClub, list: loadMatches }; ACTIONS[kind]()   dispatch map
 *
 * `src/decoy/save.ts` declares `save` and `refresh` too: no page may reach it.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-react-handlers");
let out = "";
let links: SymbolLink[] = [];

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "clarifydoc-react-handlers-"));
  await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  links = (await loadReportSummary(out)).symbolLinks ?? [];
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Route keys reachable from `file::symbol` over symbol links, any relation but import references. */
function routesFrom(file: string, symbol: string): string[] {
  const seen = new Set<string>();
  const routes = new Set<string>();
  const stack = [`${file}::${symbol}`];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const l of links) {
      if (`${l.sourceFile}::${l.sourceSymbol}` !== key || l.relation === "reference") continue;
      if (l.targetSymbol.startsWith("route:")) routes.add(l.targetSymbol);
      stack.push(`${l.targetFile}::${l.targetSymbol}`);
    }
  }
  return [...routes].sort();
}

describe("React handlers handed on by name (sample-react-handlers)", () => {
  it.each([
    ["src/pages/BarePage.tsx", "BarePage", ["route:POST /api/clubs"]],
    ["src/pages/NsPage.tsx", "NsPage", ["route:GET /api/matches/latest"]],
    ["src/pages/PropPage.tsx", "PropPage", ["route:GET /api/matches/latest"]],
    ["src/pages/HookPage.tsx", "HookPage", ["route:GET /api/matches/latest", "route:POST /api/clubs"]],
    ["src/pages/ListPage.tsx", "ListPage", ["route:GET /api/matches"]],
    // A computed key may be any of the map's: both, INFERRED.
    ["src/pages/MapPage.tsx", "MapPage", ["route:GET /api/matches", "route:POST /api/clubs"]],
  ])("%s reaches its route", (file, symbol, expected) => {
    expect(routesFrom(file, symbol)).toEqual(expected);
  });

  it("links each handler as `passes`, and never to the namesake decoy", () => {
    expect(links.filter((l) => l.targetFile === "src/decoy/save.ts")).toEqual([]);
    const passes = links.filter((l) => l.relation === "passes" && l.sourceFile.startsWith("src/pages/"));
    expect(passes.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort()).toEqual([
      // The map's values, handed on by the module that declares it.
      "<setup> -> loadMatches",
      "<setup> -> saveClub",
      "BarePage -> saveClub",
      "HookPage -> loadLatest",
      "HookPage -> save",
      "ListPage -> refresh",
      "NsPage -> loadLatest",
      "PropPage -> loadLatest",
    ]);
    const mapped = links.filter((l) => l.strategy === "dispatch:object-map");
    expect(mapped.map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol} ${l.confidence}`).sort()).toEqual([
      "MapPage -ACTIONS[]-> loadMatches INFERRED",
      "MapPage -ACTIONS[]-> saveClub INFERRED",
    ]);
  });
});
