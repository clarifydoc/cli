import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** How screens link, framework by framework (core/screen-flow.ts, `extractNavigationTargets`). */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function flowOf(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; edges: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "screen-links-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  const summary = await loadReportSummary(join(dir, "out"));
  return { summary, edges: (summary.screenFlow?.edges ?? []).map((e) => `${e.kind}: ${e.from} -> ${e.to}`) };
}

describe("AngularJS route tables and hash links", () => {
  it("routes the templates a wrapped `$routeProvider` names and follows `#/` links and `$location.path`", async () => {
    const { summary, edges } = await flowOf({
      "www/index.html": `<html><body><div ng-view></div><script src="app/app.routes.js"></script></body></html>\n`,
      "www/app/app.routes.js": `define(['angularAMD'], function (angularAMD) {
  angular.module('app.routes', ['ngRoute']).config(function ($routeProvider) {
    $routeProvider
      .when('/Garage', angularAMD.route({ templateUrl: 'views/garage.html', controller: 'GarageController' }))
      .when('/Cars/:id/Log', angularAMD.route({ templateUrl: 'views/carlog.html', controller: 'CarLogController' }));
  });
});
`,
      "www/views/garage.html": `<div><a href="#/Cars/{{ car.id }}/Log">Log</a><button ng-click="refresh()">Refresh</button></div>\n`,
      "www/views/carlog.html": `<div><button ng-click="back()">Back</button></div>\n`,
      "www/app/CarLogController.js": `define(['app'], function (app) {
  app.controller('CarLogController', function ($scope, $location) {
    $scope.back = function () { $location.path('/Garage'); };
  });
});
`,
    });
    const screen = (f: string) => summary.screens.filter((s) => s.filePath === f);
    expect(screen("www/views/garage.html").map((s) => s.routePath)).toEqual(["/Garage"]);
    expect(edges).toContain("navigate: www/views/garage.html -> www/views/carlog.html");
  }, 180_000);
});

describe("Angular components", () => {
  it("reads links in external templates and in child components used by selector, framed by the router outlet", async () => {
    const { edges, summary } = await flowOf({
      "package.json": `{ "name": "league-web", "dependencies": { "@angular/core": "^17.0.0", "@angular/router": "^17.0.0" } }\n`,
      "src/app/app.routes.ts": `import { Routes } from '@angular/router';
import { ClubsComponent } from './clubs/clubs.component';
import { ClubComponent } from './club/club.component';
import { LeagueComponent } from './league/league.component';
export const routes: Routes = [
  { path: 'clubs', component: ClubsComponent },
  { path: 'clubs/:id', component: ClubComponent },
  { path: 'league', component: LeagueComponent },
];
`,
      "src/app/app.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-root', templateUrl: './app.component.html' })
export class AppComponent {}
`,
      "src/app/app.component.html": `<nav><a routerLink="/league">League</a></nav>\n<router-outlet></router-outlet>\n`,
      "src/app/clubs/clubs.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-clubs', templateUrl: './clubs.component.html' })
export class ClubsComponent {
  clubs = [];
}
`,
      "src/app/clubs/clubs.component.html": `<h1>Clubs</h1>\n<app-club-card *ngFor="let club of clubs" [club]="club"></app-club-card>\n`,
      "src/app/club-card/club-card.component.ts": `import { Component, Input } from '@angular/core';
@Component({ selector: 'app-club-card', templateUrl: './club-card.component.html' })
export class ClubCardComponent {
  @Input() club: any;
}
`,
      "src/app/club-card/club-card.component.html": `<a [routerLink]="['/clubs', club.id]">{{ club.name }}</a>\n`,
      "src/app/club/club.component.ts": `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({ selector: 'app-club', templateUrl: './club.component.html' })
export class ClubComponent {
  constructor(private router: Router) {}
  back() { this.router.navigateByUrl('/clubs'); }
}
`,
      "src/app/club/club.component.html": `<button (click)="back()">Back</button>\n`,
      "src/app/league/league.component.ts": `import { Component } from '@angular/core';
@Component({ selector: 'app-league', template: '<h1>League</h1>' })
export class LeagueComponent {}
`,
    });
    expect(edges).toContain("navigate: src/app/clubs/clubs.component.ts -> src/app/club/club.component.ts");
    expect(edges).toContain("navigate: src/app/club/club.component.ts -> src/app/clubs/clubs.component.ts");
    expect(summary.screenFlow!.nodes.find((n) => n.id === "src/app/app.component.ts")).toMatchObject({ kind: "shell" });
    expect(edges).toContain("navigate: src/app/app.component.ts -> src/app/league/league.component.ts");
  }, 180_000);
});

describe("Laravel Blade", () => {
  it("follows `route('name')` links and forms to the pages their routes render", async () => {
    const { edges } = await flowOf({
      "composer.json": `{ "require": { "laravel/framework": "^11.0" } }\n`,
      "routes/web.php": `<?php
use App\\Http\\Controllers\\ClubController;
Route::get('/clubs', [ClubController::class, 'index'])->name('clubs.index');
Route::get('/clubs/create', [ClubController::class, 'create'])->name('clubs.create');
Route::post('/clubs', [ClubController::class, 'store'])->name('clubs.store');
`,
      "app/Http/Controllers/ClubController.php": `<?php
namespace App\\Http\\Controllers;
class ClubController extends Controller
{
    public function index() { return view('clubs.index'); }
    public function create() { return view('clubs.create'); }
    public function store() { return redirect()->route('clubs.index'); }
}
`,
      "resources/views/clubs/index.blade.php": `<h1>Clubs</h1>\n<a href="{{ route('clubs.create') }}">New club</a>\n`,
      "resources/views/clubs/create.blade.php": `<form action="{{ route('clubs.store') }}" method="post">@csrf<input name="name"><button type="submit">Save</button></form>\n<a href="{{ route('clubs.index') }}">Back</a>\n`,
    });
    expect(edges).toContain("navigate: resources/views/clubs/index.blade.php -> resources/views/clubs/create.blade.php");
    expect(edges).toContain("navigate: resources/views/clubs/create.blade.php -> resources/views/clubs/index.blade.php");
  }, 180_000);
});

describe("React links", () => {
  it("reads `<Link href>`, a base-URL prefix and a link bound to a variable", async () => {
    const { edges } = await flowOf({
      "package.json": `{ "name": "garage-web", "dependencies": { "react": "^18.3.0", "react-router-dom": "^6.26.0" } }\n`,
      "src/App.tsx": `import { BrowserRouter, Route, Routes } from "react-router-dom";
import Cars from "./pages/Cars";
import Car from "./pages/Car";
import Cart from "./pages/Cart";
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/cars" element={<Cars />} />
        <Route path="/cars/:id" element={<Car />} />
        <Route path="/cart" element={<Cart />} />
      </Routes>
    </BrowserRouter>
  );
}
`,
      "src/pages/Cars.tsx": `import { useNavigate } from "react-router-dom";
import Link from "../components/Link";
export default function Cars({ car }: { car: { id: number } }) {
  const navigate = useNavigate();
  return (
    <div>
      <Link href="/cart">Cart</Link>
      <button onClick={() => navigate(\`\${window.Garage.urlBase}/cars/\${car.id}\`)}>Open</button>
    </div>
  );
}
`,
      "src/pages/Car.tsx": `import { Link } from "react-router-dom";
export default function Car() {
  const backTo = "/cars";
  return <Link to={backTo}>Back</Link>;
}
`,
      "src/pages/Cart.tsx": `export default function Cart() {\n  return <h1>Cart</h1>;\n}\n`,
      "src/components/Link.tsx": `export default function Link({ href, children }: { href: string; children: unknown }) {\n  return <a href={href}>{children as never}</a>;\n}\n`,
    });
    expect(edges).toContain("navigate: src/pages/Cars.tsx -> src/pages/Cart.tsx");
    expect(edges).toContain("navigate: src/pages/Cars.tsx -> src/pages/Car.tsx");
    expect(edges).toContain("navigate: src/pages/Car.tsx -> src/pages/Cars.tsx");
  }, 180_000);
});
