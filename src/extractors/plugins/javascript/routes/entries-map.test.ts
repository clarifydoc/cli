import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

const FILES: Record<string, string> = {
  "package.json": `{"name":"league","dependencies":{"react":"18","react-router-dom":"6"}}`,
  "src/pages/Clubs.tsx": `export default function Clubs() { return <button onClick={() => fetch('/api/clubs')}>Load</button>; }\n`,
  "src/pages/Players.tsx": `export default function Players() { return <button onClick={() => fetch('/api/players')}>Load</button>; }\n`,
  "src/pages/Cars.tsx": `export default function Cars() { return <button onClick={() => fetch('/api/cars')}>Load</button>; }\n`,
  "src/App.tsx": `import { Routes, Route } from 'react-router-dom';
import Clubs from './pages/Clubs';
import Players from './pages/Players';
import Cars from './pages/Cars';
const defs = {
  '/clubs': { component: Clubs },
  '/players': { component: Players },
};
const pages = { '/cars': Cars };
export default function App() {
  return (
    <Routes>
      {Object.entries(defs).map(([path, def]) => (
        <Route key={path} path={path} element={<def.component />} />
      ))}
      {Object.entries(pages).map(([path, Page]) => <Route key={path} path={path} element={<Page />} />)}
    </Routes>
  );
}
`,
};

describe("Object.entries(table).map(([path, def]) => <Route/>)", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-entries-map-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes each key a route at its page, and each page a screen at the key", () => {
    expect(summary.routeMap.map((r) => `${r.path} -> ${r.componentPath}`).sort()).toEqual(["/cars -> Cars", "/clubs -> Clubs", "/players -> Players"]);
    expect(summary.screens.filter((s) => s.routePath).map((s) => `${s.filePath} ${s.routePath}`).sort()).toEqual([
      "src/pages/Cars.tsx /cars",
      "src/pages/Clubs.tsx /clubs",
      "src/pages/Players.tsx /players",
    ]);
  });
});
