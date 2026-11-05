import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { phpRouteExtractor } from "./index.js";
import { laravelRoutingResolver } from "./laravel-routing.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function file(filePath: string, source: string): Promise<FileAnalysis> {
  const tree = await parseSource(source, "php" as never, filePath);
  const facts: RouteFact[] = [];
  const routes = phpRouteExtractor.extractRoutes(tree, source, filePath, facts);
  return { ...createEmptyAnalysis(filePath, "php"), routes, routeFacts: facts };
}

describe("Laravel 11 withRouting apiPrefix", () => {
  it("serves routes/api.php under the configured prefix, and leaves web routes and other apps alone", async () => {
    const bootstrap = await file("bootstrap/app.php", `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        apiPrefix: 'v1/api',
    )->create();`);
    const api = await file("routes/api.php", `<?php
Route::get('/clubs', [ClubController::class, 'index']);
Route::prefix('admin')->group(function () { Route::get('/cars', [CarController::class, 'index']); });`);
    const web = await file("routes/web.php", `<?php Route::get('/home', fn () => 'x');`);
    const other = await file("other/routes/api.php", `<?php Route::get('/parts', [PartController::class, 'index']);`);
    laravelRoutingResolver.resolve([bootstrap, api, web, other], {} as ProjectContext);
    expect(api.routes.map((r) => r.path)).toEqual(["/v1/api/clubs", "/v1/api/admin/cars"]);
    expect(web.routes.map((r) => r.path)).toEqual(["/home"]);
    expect(other.routes.map((r) => r.path)).toEqual(["/api/parts"]);
  });

  it("drops the prefix when it is empty", async () => {
    const bootstrap = await file("bootstrap/app.php", `<?php Application::configure()->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: '');`);
    const api = await file("routes/api.php", `<?php Route::get('/clubs', [ClubController::class, 'index']);`);
    laravelRoutingResolver.resolve([bootstrap, api], {} as ProjectContext);
    expect(api.routes.map((r) => r.path)).toEqual(["/clubs"]);
  });
  it("serves an API file other than routes/api.php under the default prefix when none is stated", async () => {
    const bootstrap = await file("bootstrap/app.php", `<?php Application::configure()->withRouting(api: __DIR__.'/../routes/public.php');`);
    const api = await file("routes/public.php", `<?php Route::get('/clubs', [ClubController::class, 'index']);
Route::get('/', [ClubController::class, 'home']);`);
    laravelRoutingResolver.resolve([bootstrap, api], {} as ProjectContext);
    expect(api.routes.map((r) => r.path)).toEqual(["/api/clubs", "/api"]);
  });

  it("serves it under the stated prefix too", async () => {
    const bootstrap = await file("bootstrap/app.php", `<?php Application::configure()->withRouting(api: __DIR__.'/../routes/public.php', apiPrefix: 'v2');`);
    const api = await file("routes/public.php", `<?php Route::get('/clubs', [ClubController::class, 'index']);`);
    laravelRoutingResolver.resolve([bootstrap, api], {} as ProjectContext);
    expect(api.routes.map((r) => r.path)).toEqual(["/v2/clubs"]);
  });
});
