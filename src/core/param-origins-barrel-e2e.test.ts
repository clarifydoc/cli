import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamOrigin } from "../types/analysis.js";

/**
 * A component reached through a barrel (`export { ClubPanel } from './ClubPanel'`, a renamed one, `export *`) or a
 * lazy import, and an API module called through a namespace import: the route parameter still reaches the URL.
 * A namesake component a different barrel forwards is not the one the page renders.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.3.0", "react-router-dom": "6.0.0", axios: "1.6.0", express: "4.18.0" } }),
  "src/api/clubs.ts": `import axios from 'axios';
export function deleteClub(id: number) { return axios.delete(\`/api/clubs/\${id}\`); }
export function getClub(id: number) { return axios.get(\`/api/clubs/\${id}\`); }
export function dropSeason(id: number) { return axios.delete(\`/api/seasons/\${id}\`); }
export function dropPlayer(id: number) { return axios.delete(\`/api/players/\${id}\`); }
export function dropCar(id: number) { return axios.delete(\`/api/cars/\${id}\`); }
`,
  "src/components/ClubPanel.tsx": `import * as api from '../api/clubs';
export function ClubPanel(props: { clubId: number }) { return <button onClick={() => api.getClub(props.clubId)}>x</button>; }
`,
  "src/components/SeasonPanel.tsx": `import * as api from '../api/clubs';
export default function SeasonPanel(props: { seasonId: number }) { return <button onClick={() => api.dropSeason(props.seasonId)}>x</button>; }
`,
  "src/components/CarCard.tsx": `import * as api from '../api/clubs';
export function CarCard(props: { carId: number }) { return <button onClick={() => api.dropCar(props.carId)}>x</button>; }
`,
  "src/components/index.ts": `export { ClubPanel } from './ClubPanel';
export { CarCard as Wheel } from './CarCard';
`,
  // The namesake: its barrel is not the one the page imports.
  "src/legacy/ClubPanel.tsx": `import * as api from '../api/clubs';
export function ClubPanel(props: { clubId: number }) { return <button onClick={() => api.dropPlayer(props.clubId)}>x</button>; }
`,
  "src/legacy/index.ts": `export * from './ClubPanel';
`,
  "src/pages/ClubPage.tsx": `import React, { lazy } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../api/clubs';
import { ClubPanel, Wheel } from '../components';
const SeasonPanel = lazy(() => import('../components/SeasonPanel'));
export function ClubPage() {
  const { id } = useParams();
  const n = Number(id);
  return <div><button onClick={() => api.deleteClub(n)}>del</button><ClubPanel clubId={n} /><SeasonPanel seasonId={n} /><Wheel carId={n} /></div>;
}
`,
  "src/router.tsx": `import { Route, Routes } from 'react-router-dom';
import { ClubPage } from './pages/ClubPage';
export const R = () => <Routes><Route path="/clubs/:id" element={<ClubPage />} /></Routes>;
`,
  "server/app.js": `const express = require('express'); const app = express();
app.get('/api/clubs/:id', (q, r) => r.json({}));
app.delete('/api/clubs/:id', (q, r) => r.json({}));
app.delete('/api/seasons/:id', (q, r) => r.json({}));
app.delete('/api/players/:id', (q, r) => r.json({}));
app.delete('/api/cars/:id', (q, r) => r.json({}));
module.exports = app;
`,
};

describe("paramOrigins through barrels, lazy imports and namespace imports, end to end", () => {
  let dir: string;
  let rows: ParamOrigin[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-barrel-origins-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", path)), { recursive: true });
      await writeFile(join(dir, "repo", path), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    rows = ((await loadReportSummary(join(dir, "out"))) as { paramOrigins?: ParamOrigin[] }).paramOrigins ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const kinds = (url: string, from?: string) => rows.filter((r) => r.sink.url === url && (!from || r.hops.some((h) => h.symbol === from))).map((r) => r.origin.kind);

  it("reaches the route parameter through a namespace-imported API module", () => {
    expect(kinds("/api/clubs/${id}", "ClubPage")).toContain("route-param");
  });
  it("follows a prop into a component its parent imports through a barrel, renamed or not", () => {
    expect(kinds("/api/clubs/${id}", "<ClubPanel>")).toContain("route-param");
    expect(kinds("/api/cars/${id}")).toContain("route-param");
  });
  it("follows a prop into a lazily imported component", () => {
    expect(kinds("/api/seasons/${id}")).toContain("route-param");
  });
  it("never follows it into a namesake component another barrel forwards", () => {
    expect(kinds("/api/players/${id}")).not.toContain("route-param");
  });
});
