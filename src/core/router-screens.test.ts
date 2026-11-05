import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function analyzeFiles(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-router-screens-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-router-screens-out-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
  const summary = await loadReportSummary(out);
  return { summary, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

describe("React Router pages exported through a barrel", () => {
  let summary: ProjectAnalysis;
  let cleanup: () => void;
  beforeAll(async () => {
    ({ summary, cleanup } = await analyzeFiles({
      "package.json": `{"name":"club-app","dependencies":{"react":"18","react-router-dom":"6"}}`,
      "src/App.tsx": `import { Route, Routes } from 'react-router-dom';
import { GaragePage, FleetPage } from './pages';
export default function App() {
  return (<Routes>
    <Route path="/garage" element={<GaragePage />} />
    <Route path="/fleet" element={<FleetPage />} />
  </Routes>);
}
`,
      "src/pages/index.ts": `export { default as GaragePage } from './GaragePage';\nexport { FleetPage } from './FleetPage';\n`,
      "src/pages/GaragePage.tsx": `export default function GaragePage() { return <div>Garage</div>; }\n`,
      "src/pages/FleetPage.tsx": `export function FleetPage() { return <div>Fleet</div>; }\n`,
    }));
  }, 120_000);
  afterAll(() => cleanup());

  it("makes the page file the screen, not the barrel", () => {
    const pages = Object.fromEntries((summary.screens ?? []).filter((s) => s.routePath).map((s) => [s.routePath, s.filePath]));
    expect(pages).toEqual({ "/garage": "src/pages/GaragePage.tsx", "/fleet": "src/pages/FleetPage.tsx" });
    expect((summary.screens ?? []).some((s) => s.filePath === "src/pages/index.ts")).toBe(false);
  });
});

describe("Angular lazy child routes", () => {
  let summary: ProjectAnalysis;
  let cleanup: () => void;
  beforeAll(async () => {
    ({ summary, cleanup } = await analyzeFiles({
      "package.json": `{"name":"club-ng","dependencies":{"@angular/core":"17","@angular/router":"17"}}`,
      "src/app/app.routes.ts": `import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';
export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  { path: 'home', component: HomeComponent },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes').then(m => m.ADMIN_ROUTES) },
];
`,
      "src/app/home.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-home', template: '<p>home</p>' })
export class HomeComponent {}
`,
      "src/app/admin/admin.routes.ts": `import { Routes } from '@angular/router';
import { AuditComponent } from './audit.component';
export const ADMIN_ROUTES: Routes = [{ path: 'audit', component: AuditComponent }];
`,
      "src/app/admin/audit.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-audit', template: '<p>audit</p>' })
export class AuditComponent {}
`,
    }));
  }, 120_000);
  afterAll(() => cleanup());

  it("makes screens of the components only, not of the lazy parent's route array", () => {
    const screens = (summary.screens ?? []).filter((s) => s.routePath).map((s) => `${s.routePath} ${s.filePath}`).sort();
    expect(screens).toEqual(["admin/audit src/app/admin/audit.component.ts", "home src/app/home.component.ts"]);
  });
});

describe("several React pages in one file", () => {
  let summary: ProjectAnalysis;
  let cleanup: () => void;
  beforeAll(async () => {
    ({ summary, cleanup } = await analyzeFiles({
      "package.json": `{"name":"club-app","dependencies":{"react":"18","react-router-dom":"6"}}`,
      "src/App.tsx": `import { Route, Routes } from 'react-router-dom';
import { Standings, Fixtures } from './league';
export default function App() {
  return (<Routes>
    <Route path="/standings" element={<Standings />} />
    <Route path="/fixtures" element={<Fixtures />} />
  </Routes>);
}
`,
      "src/league.tsx": `export function Standings() { return <div>Table</div>; }
export function Fixtures() { return <div>Matches</div>; }
`,
    }));
  }, 120_000);
  afterAll(() => cleanup());

  it("makes one screen per page", () => {
    const pages = (summary.screens ?? []).filter((s) => s.routePath).map((s) => `${s.name} ${s.routePath} ${s.filePath}`).sort();
    expect(pages).toEqual(["Fixtures /fixtures src/league.tsx", "Standings /standings src/league.tsx"]);
  });
});
