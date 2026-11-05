import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** Navigation calls beyond `navigate`/`router.push`: each gives its screen a `navigate` edge. */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function edgesOf(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "nav-calls-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  const summary = await loadReportSummary(join(dir, "out"));
  return (summary.screenFlow?.edges ?? []).map((e) => `${e.kind}: ${e.from} -> ${e.to}`);
}

const pkg = `{ "name": "league-web", "dependencies": { "react": "^18.0.0", "react-router-dom": "^6.0.0" } }\n`;
const page = (name: string, body: string) => `import React from 'react';\nexport default function ${name}() {\n  ${body}\n  return <div>${name}</div>;\n}\n`;

describe("navigation call shapes", () => {
  it("reads redirect, location.assign, history.pushState and router.replace as navigation", async () => {
    const edges = await edgesOf({
      "package.json": pkg,
      "src/App.tsx": `import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Clubs from './pages/Clubs';
import Cars from './pages/Cars';
import Garage from './pages/Garage';
import Fleet from './pages/Fleet';
import Table from './pages/Table';
export default function App() {
  return <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/clubs" element={<Clubs />} />
    <Route path="/cars" element={<Cars />} />
    <Route path="/garage" element={<Garage />} />
    <Route path="/fleet" element={<Fleet />} />
    <Route path="/table" element={<Table />} />
  </Routes>;
}
`,
      "src/pages/Home.tsx": page("Home", `if (!ok) redirect('/clubs'); if (old) permanentRedirect('/cars');`),
      "src/pages/Clubs.tsx": page("Clubs", `const go = () => window.location.assign('/garage');`),
      "src/pages/Cars.tsx": page("Cars", `const go = () => history.pushState({}, '', '/fleet');`),
      "src/pages/Garage.tsx": page("Garage", `const go = () => router.replace('/table');`),
      "src/pages/Fleet.tsx": page("Fleet", `const go = () => location.replace('/clubs');`),
      "src/pages/Table.tsx": page("Table", `const go = () => { res.redirect('/cars'); history.replaceState({}, '', \`\${base}/\${car.id}\`); };`),
    });
    expect(edges).toContain("navigate: src/pages/Home.tsx -> src/pages/Clubs.tsx");
    expect(edges).toContain("navigate: src/pages/Home.tsx -> src/pages/Cars.tsx");
    expect(edges).toContain("navigate: src/pages/Clubs.tsx -> src/pages/Garage.tsx");
    expect(edges).toContain("navigate: src/pages/Cars.tsx -> src/pages/Fleet.tsx");
    expect(edges).toContain("navigate: src/pages/Garage.tsx -> src/pages/Table.tsx");
    expect(edges).toContain("navigate: src/pages/Fleet.tsx -> src/pages/Clubs.tsx");
    // A response's redirect is the server's, not a page navigating.
    // `replaceState` rewrites the current page's URL, it goes nowhere.
    expect(edges.filter((e) => e.startsWith("navigate: src/pages/Table.tsx"))).toEqual([]);
  }, 180_000);

  it("reads Angular navigateByUrl and Ionic NavController calls", async () => {
    const edges = await edgesOf({
      "package.json": `{ "name": "league-web", "dependencies": { "@angular/core": "^17.0.0", "@angular/router": "^17.0.0", "@ionic/angular": "^7.0.0" } }\n`,
      "src/app/app.routes.ts": `import { Routes } from '@angular/router';
import { ClubsComponent } from './clubs/clubs.component';
import { CarsComponent } from './cars/cars.component';
import { GarageComponent } from './garage/garage.component';
export const routes: Routes = [
  { path: 'clubs', component: ClubsComponent },
  { path: 'cars', component: CarsComponent },
  { path: 'garage', component: GarageComponent },
];
`,
      "src/app/clubs/clubs.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-clubs', template: '<p>Clubs</p>' })
export class ClubsComponent {
  constructor(private router: Router, private navCtrl: NavController) {}
  open() { this.router.navigateByUrl('/cars'); }
  next() { this.navCtrl.navigateForward('/garage'); }
}
`,
      "src/app/cars/cars.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-cars', template: '<p>Cars</p>' })
export class CarsComponent {
  back() { this.navCtrl.navigateRoot(['/clubs']); }
}
`,
      "src/app/garage/garage.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-garage', template: '<p>Garage</p>' })
export class GarageComponent {}
`,
    });
    expect(edges).toContain("navigate: src/app/clubs/clubs.component.ts -> src/app/cars/cars.component.ts");
    expect(edges).toContain("navigate: src/app/clubs/clubs.component.ts -> src/app/garage/garage.component.ts");
    expect(edges).toContain("navigate: src/app/cars/cars.component.ts -> src/app/clubs/clubs.component.ts");
  }, 180_000);

  it("reads SvelteKit goto", async () => {
    const edges = await edgesOf({
      "package.json": `{ "name": "league-web", "devDependencies": { "@sveltejs/kit": "^2.0.0", "svelte": "^4.0.0" } }\n`,
      "src/routes/+page.svelte": `<script>\n  import { goto } from '$app/navigation';\n</script>\n<button on:click={() => goto('/clubs')}>Clubs</button>\n`,
      "src/routes/clubs/+page.svelte": `<h1>Clubs</h1>\n`,
    });
    expect(edges.some((e) => e.includes("+page.svelte -> src/routes/clubs/+page.svelte"))).toBe(true);
  }, 180_000);
});
