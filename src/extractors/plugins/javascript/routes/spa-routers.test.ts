import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import { resolveTarget, buildFilePathMap } from "../../../shared/link-scoring.js";
import type { FileAnalysis } from "../../../../types/analysis.js";

/**
 * SPA-router extraction fixes from the greencart and real-repo corpus:
 *  - nested <Route> children must inherit the parent prefix, or the composed
 *    path never joins a screen (`product-list` vs `/seller/product-list`);
 *  - an arbitrary object with a `path:` key is NOT a route — category/sidebar
 *    data arrays produced phantom frontend routes;
 *  - ESM-TS `.js` specifiers must resolve to the `.ts` file on disk.
 */

async function routesOf(src: string, file = "App.tsx") {
  const tree = await parseSource(src, "typescript" as any, file);
  return javascriptRouteExtractor.extractRoutes(tree, src);
}

describe("react-router nested <Route> prefix composition", () => {
  it("prefixes relative children with every ancestor Route path", async () => {
    const src = `export default function App() {
  return (
    <Routes>
      <Route path="/seller" element={isSeller ? <SellerLayout/> : <SellerLogin/>}>
        <Route index element={<AddProduct/>} />
        <Route path="product-list" element={<ProductList/>} />
        <Route path="orders" element={<Orders/>} />
      </Route>
    </Routes>
  );
}`;
    const paths = (await routesOf(src)).map((r) => r.path);
    expect(paths).toContain("/seller");
    expect(paths).toContain("/seller/product-list");
    expect(paths).toContain("/seller/orders");
    expect(paths).not.toContain("product-list");
  });

  it("leaves an ABSOLUTE child path untouched and composes multi-level nesting", async () => {
    const src = `const r = (
  <Route path="/admin">
    <Route path="users">
      <Route path=":id" element={<UserDetail/>} />
    </Route>
    <Route path="/absolute" element={<Abs/>} />
  </Route>
);`;
    const paths = (await routesOf(src)).map((r) => r.path);
    expect(paths).toContain("/admin/users/:id");
    expect(paths).toContain("/absolute");
    expect(paths).not.toContain("/admin//absolute");
  });
});

describe("vue-router path-object guard", () => {
  it("ignores data objects that merely carry a path key", async () => {
    const src = `export const categories = [
  { text: "Vegetables", path: "Vegetables", image: veg },
  { text: "Fruits", path: "Fruits", image: fruit },
];
export const sidebarLinks = [
  { name: "Product List", path: "/seller/product-list", icon: listIcon },
];`;
    const routes = await routesOf(src, "assets.ts");
    expect(routes).toHaveLength(0);
  });

  it("still extracts real route configs (component / children / redirect)", async () => {
    const src = `export const routes = [
  { path: "/", component: Home },
  { path: "/old", redirect: "/" },
  { path: "/shop", children: [{ path: "cart", component: Cart }] },
];`;
    const paths = (await routesOf(src, "router.ts")).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/old", "/shop", "cart"]));
  });
});

describe("ESM-TS .js specifier resolution", () => {
  const fa = (filePath: string): FileAnalysis => ({ filePath } as unknown as FileAnalysis);

  it("resolves ./x.js to the x.ts file on disk (and .jsx → .tsx)", () => {
    const map = buildFilePathMap([fa("src/sharedService.ts"), fa("src/ui/Card.tsx"), fa("src/app.ts")]);
    expect(resolveTarget("./sharedService.js", "src/app.ts", map)).toBe("src/sharedService.ts");
    expect(resolveTarget("./ui/Card.jsx", "src/app.ts", map)).toBe("src/ui/Card.tsx");
  });

  it("still prefers an actual .js file when one exists", () => {
    const map = buildFilePathMap([fa("src/legacy.js"), fa("src/app.ts")]);
    expect(resolveTarget("./legacy.js", "src/app.ts", map)).toBe("src/legacy.js");
  });
});
