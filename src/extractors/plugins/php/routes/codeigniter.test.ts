import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { codeigniterRouteExtractor as phpRouteExtractor } from "./codeigniter.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * CodeIgniter is convention-routed: a URL maps onto controllers/<dir>/<file>.php
 * + a public method, with no route table. The engine had no PHP route extractor
 * at all, so every Vue `fetch('/site/cui_garage_json')` had no backend route to
 * join to (photo-booth: routeMap was 21 frontend-only routes for 75 controllers).
 */
async function routesOf(source: string, filePath: string): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "php" as any, filePath);
  return phpRouteExtractor.extractRoutes(tree, source, filePath);
}

describe("CodeIgniter convention routing", () => {
  it("maps a sub-dir controller's public methods to /dir/file/method, index → base", async () => {
    const SRC = `<?php
class Photos extends JAR_Controller {
  function Photos() { parent::__construct(); }   // PHP4 constructor — not a route
  function index() { show_error(""); }
  function archive() { return $this->drivers_model->get_driver(1); }
  private function _validate() { return true; }   // private — not a route
}`;
    const routes = await routesOf(SRC, "application/controllers/api/photos.php");
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/api/photos"); // index
    expect(paths).toContain("/api/photos/archive");
    expect(paths).not.toContain("/api/photos/_validate");
    expect(paths.some((p) => /photos$/i.test(p) && p.includes("Photos"))).toBe(false); // no ctor route
    // CI dispatches every verb to one URI, so routes carry no method, kind api.
    for (const r of routes) {
      expect(r.httpMethod).toBeNull();
      expect(r.kind).toBe("api");
    }
  });

  it("derives the base path from the file basename (handles _-prefixed files)", async () => {
    const SRC = `<?php
class Checkout extends JAR_Controller {
  function verify() { return 1; }
}`;
    const top = await routesOf(SRC, "application/controllers/checkout.php");
    expect(top.map((r) => r.path)).toEqual(["/checkout/verify"]);

    const legacy = await routesOf(SRC, "application/controllers/_checkout.php");
    expect(legacy.map((r) => r.path)).toEqual(["/_checkout/verify"]);
  });

  it("captures the handler method's calls so they reach the call graph", async () => {
    const SRC = `<?php
class Site extends JAR_Controller {
  function cui_garage_json() { return $this->garage_model->get_garage(5); }
}`;
    const [route] = await routesOf(SRC, "application/controllers/site.php");
    expect(route!.handler).toBe("cui_garage_json");
    expect(route!.calls.some((c) => /get_garage/.test(c.name ?? ""))).toBe(true);
  });

  it("ignores PHP files that are not under a controllers/ directory", async () => {
    const SRC = `<?php
class Cars_model extends CI_Model {
  function get_cars() { return $this->db->get('cars'); }
}`;
    expect(await routesOf(SRC, "application/models/cars_model.php")).toEqual([]);
  });
});

/**
 * Parameters: CI passes the URI segments after the method as arguments, and
 * the body reads input through `$this->input` (CI3) / `$this->request` (CI4).
 */
describe("CodeIgniter route parameters", () => {
  it("binds signature params from the route and input reads by accessor", async () => {
    const SRC = `<?php
class Photos extends CI_Controller {
  function archive($id, $page = 1) {
    $title = $this->input->post('title');
    $sort = $this->input->get('sort');
    $key = $this->input->get_request_header('X-Api-Key');
    return $this->photos_model->archive($id, $title);
  }
  function upload() {
    $json = $this->request->getJSON();
    $name = $this->request->getVar('name');
    $file = $this->request->getFile('photo');
    $ct = $this->request->getHeaderLine('Content-Type');
  }
  function index() { return 1; }
}`;
    const routes = await routesOf(SRC, "application/controllers/photos.php");
    const byPath = (p: string) => routes.find((r) => r.path === p)!;
    expect(byPath("/photos/archive").params).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "page", type: null, binding: "route", inferred: true },
      { name: "title", type: null, binding: "form", inferred: true },
      { name: "sort", type: null, binding: "query", inferred: true },
      { name: "X-Api-Key", type: null, binding: "header", inferred: true },
    ]);
    expect(byPath("/photos/upload").params).toEqual([
      { name: "name", type: null, binding: "body", inferred: true },
      { name: "Content-Type", type: null, binding: "header", inferred: true },
      { name: "photo", type: "UploadedFile", binding: "form", inferred: true },
      { name: "body", type: null, binding: "body", inferred: true },
    ]);
    expect(byPath("/photos").params).toBeUndefined();
    // CI has no auth layer of its own.
    for (const r of routes) expect(r.auth).toBeUndefined();
  });
});

describe("CodeIgniter URI segments, constructor guards and routes.php", () => {
  it("aliases the segments a method binds, so a call carrying an id joins the one route", async () => {
    const routes = await routesOf(`<?php
class Garage extends CI_Controller {
  function index($page = 1) {}
  function car($car_id) {}
  function service($car_id, $visit = null) {}
  function list_all() {}
}`, "application/controllers/ajax/garage.php");
    const by = Object.fromEntries(routes.map((r) => [r.path, r.aliases ?? []]));
    expect(by["/ajax/garage"]).toEqual(["/ajax/garage/index", "/ajax/garage/index/{page}"]);
    expect(by["/ajax/garage/car"]).toEqual(["/ajax/garage/car/{car_id}"]);
    expect(by["/ajax/garage/service"]).toEqual(["/ajax/garage/service/{car_id}", "/ajax/garage/service/{car_id}/{visit}"]);
    expect(by["/ajax/garage/list_all"]).toEqual([]);
  });

  it("guards every method with the login check the constructor calls", async () => {
    const routes = await routesOf(`<?php
class Fleet extends Base_Controller {
  function Fleet() {
    parent::__construct();
    $this->is_manager_logged_in();
    $this->load->model('cars_model');
  }
  function index() {}
  function view($id) {}
}`, "application/controllers/admin/fleet.php");
    expect(routes.map((r) => r.middleware)).toEqual([["is_manager_logged_in"], ["is_manager_logged_in"]]);
    expect(routes[0]!.auth).toMatchObject({ inherited: true, anonymous: false });
    const open = await routesOf(`<?php
class Showroom extends CI_Controller {
  function __construct() { parent::__construct(); $this->load->helper('url'); }
  function index() {}
}`, "application/controllers/showroom.php");
    expect(open[0]!.middleware).toEqual([]);
    expect(open[0]!.auth).toBeUndefined();
  });

  it("reads config/routes.php entries as facts and aliases the routes they name", async () => {
    const { codeigniterRoutesResolver } = await import("./codeigniter-resolver.js");
    const table = `<?php
$route['default_controller'] = "showroom";
$route['autos'] = "showroom/index";
$route['werkstatt'] = 'garage/service';
$route['cars/(:num)'] = "garage/car/$1";
$route['nowhere'] = "missing/thing";
`;
    const facts: import("../../../../types/analysis.js").RouteFact[] = [];
    const tree = await parseSource(table, "php" as any, "application/config/routes.php");
    phpRouteExtractor.extractRoutes(tree, table, "application/config/routes.php", facts);
    expect(facts.map((f) => f.data)).toEqual([
      { from: "autos", to: "showroom/index" },
      { from: "werkstatt", to: "garage/service" },
      { from: "cars/(:num)", to: "garage/car/$1" },
      { from: "nowhere", to: "missing/thing" },
    ]);
    const showroom = await routesOf(`<?php class Showroom extends CI_Controller { function index() {} }`, "application/controllers/showroom.php");
    const garage = await routesOf(`<?php class Garage extends CI_Controller { function car($id) {} function service() {} }`, "application/controllers/garage.php");
    const analyses = [
      { filePath: "application/config/routes.php", routes: [], routeFacts: facts },
      { filePath: "application/controllers/showroom.php", routes: showroom },
      { filePath: "application/controllers/garage.php", routes: garage },
    ] as unknown as import("../../../../types/analysis.js").FileAnalysis[];
    codeigniterRoutesResolver.resolve(analyses, {} as never);
    const aliases = analyses.flatMap((a) => a.routes).map((r) => [r.path, r.aliases ?? []]);
    expect(aliases).toEqual([
      ["/showroom", ["/showroom/index", "/autos"]],
      ["/garage/car", ["/garage/car/{id}", "/cars/{p1}"]],
      ["/garage/service", ["/werkstatt"]],
    ]);
  });

  it("drops the convention rows of a sub-project routed by Laravel's facade", async () => {
    const { codeigniterRoutesResolver } = await import("./codeigniter-resolver.js");
    const { phpRouteExtractor: all } = await import("./index.js");
    const routesFile = `<?php\nRoute::get('v1/clubs', ['uses' => 'ShowController@index']);\n`;
    const facts: import("../../../../types/analysis.js").RouteFact[] = [];
    const routes = all.extractRoutes(await parseSource(routesFile, "php" as any, "routes/api.php"), routesFile, "routes/api.php", facts);
    const ctlSrc = `<?php namespace League\\Api\\V1\\Controllers; class ShowController extends Controller { public function index() {} }`;
    const ctl = await routesOf(ctlSrc, "app/Api/V1/Controllers/ShowController.php");
    expect(ctl.map((r) => r.path)).toEqual(["/showcontroller"]);
    const analyses = [
      { filePath: "routes/api.php", projectId: "league", routes, routeFacts: facts },
      { filePath: "app/Api/V1/Controllers/ShowController.php", projectId: "league", routes: ctl },
      { filePath: "legacy/application/controllers/garage.php", projectId: "garage", routes: await routesOf(`<?php class Garage extends CI_Controller { function service() {} }`, "legacy/application/controllers/garage.php") },
    ] as unknown as import("../../../../types/analysis.js").FileAnalysis[];
    codeigniterRoutesResolver.resolve(analyses, {} as never);
    expect(analyses.map((a) => a.routes.map((r) => `${r.httpMethod} ${r.path}`))).toEqual([
      ["GET /api/v1/clubs"], [], ["null /garage/service"],
    ]);
  });
});
