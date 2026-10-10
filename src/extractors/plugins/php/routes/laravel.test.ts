import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { phpRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Laravel declares routes as `Route::` facade calls in routes/web.php /
 * routes/api.php. Before this extractor a Laravel backend produced zero api
 * routes, so no frontend api-call could ever join to it.
 */
async function routesOf(source: string, filePath = "routes/web.php"): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "php" as any, filePath);
  return phpRouteExtractor.extractRoutes(tree, source, filePath);
}

describe("Laravel Route:: facade routing", () => {
  it("extracts verb routes with tuple, string, and closure handlers", async () => {
    const SRC = `<?php
use App\\Http\\Controllers\\UserController;

Route::get('/users/{id}', [UserController::class, 'show']);
Route::post('/users', 'UserController@store');
Route::delete('/users/{id}', [App\\Http\\Controllers\\UserController::class, 'destroy']);
Route::put('/users/{id}', function ($id) {
    return $this->userService->update($id);
});
`;
    const routes = await routesOf(SRC);
    expect(routes).toHaveLength(4);

    const get = routes.find((r) => r.httpMethod === "GET")!;
    expect(get.path).toBe("/users/{id}");
    expect(get.handler).toBe("UserController#show");

    const post = routes.find((r) => r.httpMethod === "POST")!;
    expect(post.handler).toBe("UserController#store");

    // Namespaced ::class constant reduces to the bare class name.
    const del = routes.find((r) => r.httpMethod === "DELETE")!;
    expect(del.handler).toBe("UserController#destroy");

    // Closure handler: no name, but the body's calls survive for the trace.
    const put = routes.find((r) => r.httpMethod === "PUT")!;
    expect(put.handler).toBeNull();
    expect(put.calls.some((c) => /update/.test(c.name ?? ""))).toBe(true);

    for (const r of routes) expect(r.kind).toBe("api");
  });

  it("expands Route::resource into the 7 CRUD routes, apiResource into 5", async () => {
    const SRC = `<?php
Route::resource('photos', PhotoController::class);
Route::apiResource('tags', TagController::class);
`;
    const routes = await routesOf(SRC);
    const photos = routes.filter((r) => r.path.startsWith("/photos"));
    expect(photos).toHaveLength(7);
    expect(photos.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "GET /photos", "GET /photos/create", "POST /photos", "GET /photos/{id}",
        "GET /photos/{id}/edit", "PUT /photos/{id}", "DELETE /photos/{id}",
      ]),
    );
    expect(photos.find((r) => r.path === "/photos/{id}" && r.httpMethod === "GET")!.handler)
      .toBe("PhotoController#show");

    const tags = routes.filter((r) => r.path.startsWith("/tags"));
    expect(tags).toHaveLength(5); // no create/edit form endpoints
    expect(tags.some((r) => r.path.includes("/create") || r.path.includes("/edit"))).toBe(false);
  });

  it("composes group prefixes: array options, fluent ->prefix, and nesting", async () => {
    const SRC = `<?php
Route::group(['prefix' => 'admin'], function () {
    Route::get('/dashboard', [AdminController::class, 'index']);
});
Route::prefix('api')->group(function () {
    Route::middleware('auth')->get('/me', [MeController::class, 'show']);
    Route::prefix('v1')->group(function () {
        Route::get('/orders', [OrderController::class, 'index']);
    });
});
`;
    const routes = await routesOf(SRC);
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/admin/dashboard");
    expect(paths).toContain("/api/me"); // fluent verb behind a fluent group
    expect(paths).toContain("/api/v1/orders"); // nested groups compose
  });

  it("handles Route::match (per-verb), Route::any (wildcard), Route::view (GET)", async () => {
    const SRC = `<?php
Route::match(['get', 'post'], '/multi', [MultiController::class, 'handle']);
Route::any('/anything', [CatchController::class, 'all']);
Route::view('/welcome', 'welcome');
`;
    const routes = await routesOf(SRC);
    const multi = routes.filter((r) => r.path === "/multi");
    expect(multi.map((r) => r.httpMethod).sort()).toEqual(["GET", "POST"]);

    expect(routes.find((r) => r.path === "/anything")!.httpMethod).toBeNull();

    const view = routes.find((r) => r.path === "/welcome")!;
    expect(view.httpMethod).toBe("GET");
    expect(view.handler).toBe("welcome");
  });

  it("mounts routes/api.php under /api (RouteServiceProvider convention)", async () => {
    const SRC = `<?php
Route::get('/products', [ProductController::class, 'index']);
Route::apiResource('orders', OrderController::class);
`;
    const api = await routesOf(SRC, "routes/api.php");
    expect(api.map((r) => r.path)).toContain("/api/products");
    expect(api.map((r) => r.path)).toContain("/api/orders/{id}");

    // web.php keeps its paths bare.
    const web = await routesOf(SRC, "routes/web.php");
    expect(web.map((r) => r.path)).toContain("/products");
  });

  it("does NOT let CodeIgniter convention routing claim Laravel controllers", async () => {
    const SRC = `<?php
namespace App\\Http\\Controllers;

class ProductController extends Controller {
  public function index() { return Product::all(); }
}`;
    const routes = await routesOf(SRC, "app/Http/Controllers/ProductController.php");
    expect(routes).toEqual([]); // no phantom /productcontroller/... routes
  });

  it("ignores non-route facade calls and non-Route static calls", async () => {
    const SRC = `<?php
Route::middleware('auth')->group(function () {
    Route::get('/inside', [C::class, 'a']);
});
Cache::get('key');
SomeModel::get();
`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => r.path)).toEqual(["/inside"]); // middleware-only group adds no prefix
  });
});

/**
 * The attribute layer: middleware from every place Laravel declares it,
 * reduced to `auth`, and a closure handler's params. Controller handlers
 * get their params from the project-level join (`core/request-schemas.ts`)
 * via the PHP plugin's `bindParam` + `requestAccess`, not here.
 */
describe("Laravel middleware → auth", () => {
  it("reads the chain below and above the verb, and inherits from every enclosing group", async () => {
    const SRC = `<?php
Route::middleware(['auth:sanctum', 'role:admin'])->group(function () {
    Route::get('/orders/{order}', [OrderController::class, 'show'])->name('orders.show')->middleware('can:view,order');
    Route::prefix('reports')->middleware('throttle:60,1')->group(function () {
        Route::get('/daily', [ReportController::class, 'daily']);
    });
});
Route::group(['prefix' => 'v1', 'middleware' => ['auth']], function () {
    Route::post('/orders', [OrderController::class, 'store']);
});
Route::group(['middleware' => 'auth.basic'], function () {
    Route::apiResource('tags', TagController::class);
});
Route::middleware('guest')->get('/login', [AuthController::class, 'form']);
Route::get('/health', fn () => 'ok');
Route::middleware('permission:orders.export')->get('/export', [OrderController::class, 'export']);
Route::get('/verified', [ProfileController::class, 'show'])->middleware(['auth', 'verified']);
`;
    const routes = await routesOf(SRC, "routes/api.php");
    const byPath = (p: string) => routes.find((r) => r.path === p)!;

    // Group middleware is inherited; the trailing `->middleware('can:…')` is the route's own.
    const show = byPath("/api/orders/{order}");
    expect(show.middleware).toEqual(["auth:sanctum", "role:admin", "can:view,order"]);
    expect(show.auth).toEqual({
      schemes: ["sanctum"], roles: ["admin"], policies: ["can:view,order"], anonymous: false, inherited: false,
    });

    // A nested group adds its middleware; `throttle` is middleware but not auth.
    const daily = byPath("/api/reports/daily");
    expect(daily.middleware).toEqual(["auth:sanctum", "role:admin", "throttle:60,1"]);
    expect(daily.auth).toEqual({ schemes: ["sanctum"], roles: ["admin"], policies: [], anonymous: false, inherited: true });

    // Options-array group: `'middleware' => ['auth']` + `'prefix' => 'v1'`.
    const store = byPath("/api/v1/orders");
    expect(store.middleware).toEqual(["auth"]);
    expect(store.auth).toMatchObject({ schemes: ["auth"], inherited: true });

    // A string `'middleware' => 'auth.basic'` and a resource expansion inherit alike.
    const tags = routes.filter((r) => r.path.startsWith("/api/tags"));
    expect(tags).toHaveLength(5);
    for (const t of tags) expect(t.auth).toMatchObject({ schemes: ["basic"], inherited: true });

    // `guest` waives auth; a bare route declares nothing at all.
    expect(byPath("/api/login").auth).toMatchObject({ anonymous: true });
    expect(byPath("/api/health").auth).toBeUndefined();
    expect(byPath("/api/health").middleware).toEqual([]);

    // `permission:` is a policy; `->middleware([...])` above the verb with several entries.
    expect(byPath("/api/export").auth).toMatchObject({ policies: ["permission:orders.export"], inherited: false });
    expect(byPath("/api/verified").middleware).toEqual(["auth", "verified"]);
    expect(byPath("/api/verified").auth).toMatchObject({ schemes: ["auth"], policies: ["verified"], inherited: false });
  });

  it("leaves params to the join for controller handlers, but fills them for closures", async () => {
    const SRC = `<?php
Route::get('/users/{id}', [UserController::class, 'show']);
Route::put('/users/{id}', function (Request $request, $id) {
    $name = $request->input('name');
    $page = $request->query('page');
    return $this->userService->update($id, $name);
});
`;
    const routes = await routesOf(SRC);
    expect(routes.find((r) => r.httpMethod === "GET")!.params).toBeUndefined();
    const put = routes.find((r) => r.httpMethod === "PUT")!;
    expect(put.params).toEqual([
      { name: "request", type: "Request", binding: "services", inferred: true },
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "name", type: null, binding: "body", inferred: true },
      { name: "page", type: null, binding: "query", inferred: true },
    ]);
  });
});

describe("Laravel handler forms beyond the tuple", () => {
  it("names an invokable controller's __invoke and reads the 'uses' options key", async () => {
    const src = `<?php
use App\\Http\\Controllers\\LoginController;
Route::post('me', LoginController::class);
Route::group(['namespace' => 'App\\Api', 'prefix' => 'v1'], static function (): void {
    Route::get('accounts', ['uses' => 'AccountController@accounts', 'as' => 'accounts']);
});`;
    const routes = await routesOf(src);
    expect(routes.find((r) => r.path === "/me")!.handler).toBe("LoginController#__invoke");
    expect(routes.find((r) => r.path === "/v1/accounts")!.handler).toBe("AccountController#accounts");
  });
});
