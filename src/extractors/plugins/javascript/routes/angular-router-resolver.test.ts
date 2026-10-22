import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * Angular standalone routes split over lazy route modules (real-repo FP: every
 * entity screen kept a relative path, and dedupe merged `new` / `:id/view`
 * across features — 15 of 45 frontend routes lost).
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0" } }),
  "src/app/app.routes.ts": `import { Routes } from '@angular/router';
const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home') },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes') },
  { path: '', loadChildren: () => import('./entities/entity.routes') },
];
export default routes;
`,
  "src/app/admin/admin.routes.ts": `import { Routes } from '@angular/router';
const routes: Routes = [
  { path: 'metrics', loadComponent: () => import('./metrics/metrics') },
];
export default routes;
`,
  "src/app/entities/entity.routes.ts": `import { Routes } from '@angular/router';
const routes: Routes = [
  { path: 'club', loadChildren: () => import('./club/club.routes') },
  { path: 'player', loadChildren: () => import('./player/player.routes') },
];
export default routes;
`,
  "src/app/entities/club/club.routes.ts": `import { Routes } from '@angular/router';
const clubRoute: Routes = [
  { path: '', loadComponent: () => import('./list/club') },
  { path: ':id/view', loadComponent: () => import('./detail/club-detail') },
  { path: 'new', loadComponent: () => import('./update/club-update') },
];
export default clubRoute;
`,
  "src/app/entities/player/player.routes.ts": `import { Routes } from '@angular/router';
const playerRoute: Routes = [
  { path: '', loadComponent: () => import('./list/player') },
  { path: ':id/view', loadComponent: () => import('./detail/player-detail') },
  { path: 'new', loadComponent: () => import('./update/player-update') },
];
export default playerRoute;
`,
};

describe("Angular loadChildren", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-angular-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each lazy module's routes under the record that loads it, through two levels", () => {
    const paths = (summary.routeMap ?? [])
      .filter((r) => r.kind === "frontend" && /\/(?:club|player|admin)\//.test(r.filePath ?? ""))
      .map((r) => `${(r.filePath ?? "").split("/").slice(-2).join("/")} ${r.path}`)
      .sort();
    expect(paths).toEqual([
      "admin/admin.routes.ts admin/metrics",
      "club/club.routes.ts club",
      "club/club.routes.ts club/:id/view",
      "club/club.routes.ts club/new",
      "player/player.routes.ts player",
      "player/player.routes.ts player/:id/view",
      "player/player.routes.ts player/new",
    ]);
  });
});
