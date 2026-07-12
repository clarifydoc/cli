import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { codeigniterRouteExtractor as phpRouteExtractor } from "./codeigniter.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * CodeIgniter is convention-routed: a URL maps onto controllers/<dir>/<file>.php
 * + a public method, with no route table. The engine had no PHP route extractor
 * at all, so every Vue `fetch('/site/cui_cart_json')` had no backend route to
 * join to (ist-photo: routeMap was 21 frontend-only routes for 75 controllers).
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
  function archive() { return $this->customers_model->get_customer(1); }
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
  function cui_cart_json() { return $this->cart_model->get_cart(5); }
}`;
    const [route] = await routesOf(SRC, "application/controllers/site.php");
    expect(route!.handler).toBe("cui_cart_json");
    expect(route!.calls.some((c) => /get_cart/.test(c.name ?? ""))).toBe(true);
  });

  it("ignores PHP files that are not under a controllers/ directory", async () => {
    const SRC = `<?php
class Orders_model extends CI_Model {
  function get_orders() { return $this->db->get('orders'); }
}`;
    expect(await routesOf(SRC, "application/models/orders_model.php")).toEqual([]);
  });
});
