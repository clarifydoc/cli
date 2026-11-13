import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { objectTypeMembers, patternBindings } from "./destructured-params.js";

/**
 * A component whose props arrive as one destructured object: `table.nextPage()` is a call on the `Table` the
 * annotation names, wherever the annotation is written (inline, a same-file interface, a renamed binding).
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.3.0" } }),
  "src/table.ts": `export class Table {
  nextPage(): void {}
}
`,
  // A namesake method: only the annotation tells which class a call means.
  "src/grid.ts": `export class Grid {
  nextPage(): void {}
}
`,
  "src/Inline.tsx": `import { Table } from './table';
export function Inline({ table }: { table: Table }) {
  table.nextPage();
  return null;
}
`,
  "src/Renamed.tsx": `import { Table } from './table';
export function Renamed({ table: grid }: { table: Table }) {
  grid.nextPage();
  return null;
}
`,
  "src/Named.tsx": `import { Table } from './table';
interface Props { table: Table; onDone?: () => void }
export function Named({ table }: Props) {
  table.nextPage();
  return null;
}
`,
  "src/Untyped.tsx": `export function Untyped({ table }) {
  table.nextPage();
  return null;
}
`,
};

const linksFrom = (s: ProjectAnalysis, file: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`);

describe("destructured parameters", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-destructured-params-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a call on a destructured prop to the class its annotation names", () => {
    expect(linksFrom(summary, "src/Inline.tsx")).toContain("Inline -table.nextPage-> src/table.ts#Table.nextPage");
    expect(linksFrom(summary, "src/Renamed.tsx")).toContain("Renamed -grid.nextPage-> src/table.ts#Table.nextPage");
    expect(linksFrom(summary, "src/Named.tsx")).toContain("Named -table.nextPage-> src/table.ts#Table.nextPage");
  });

  it("links nothing for a prop whose type is not stated", () => {
    expect(linksFrom(summary, "src/Untyped.tsx").filter((r) => r.includes("nextPage"))).toEqual([]);
  });

  it("reads the bindings of a pattern and the members of an object type", () => {
    expect(patternBindings("{ n = a < b, table }").map((b) => b.binding)).toEqual(["n", "table"]);
    expect(patternBindings("{ a, b: c, d = 1, e: f = g(1, 2), ...rest, h: { i } }")).toEqual([
      { binding: "a", key: "a" },
      { binding: "c", key: "b" },
      { binding: "d", key: "d" },
      { binding: "f", key: "e" },
    ]);
    expect([...objectTypeMembers("{ kind:\n | 'a'\n | 'b'; // note\n table: Table }")]).toEqual([["kind", "'a' | 'b'"], ["table", "Table"]]);
    expect([...objectTypeMembers("{ a: Map<string, X>; b?: Y | null, c: () => void, readonly d: Z }")]).toEqual([
      ["a", "Map<string, X>"],
      ["b", "Y"],
      ["d", "Z"],
    ]);
  });
});
