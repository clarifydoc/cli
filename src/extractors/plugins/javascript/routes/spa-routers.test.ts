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

describe("react-router: the component a <Route> renders", () => {
  // `componentPath` is what the screen builder follows from a route to its
  // page file. JSX routes never set it, so every page they rendered was a
  // screen without a route and the route file became the screen instead.
  const rendered = async (jsx: string) => {
    const [route] = await routesOf(`const r = (${jsx});`);
    return { handler: route?.handler ?? null, componentPath: route?.componentPath ?? null };
  };

  it("reads component / Component / element / render", async () => {
    expect(await rendered(`<Route path="/@:username" component={Profile} />`))
      .toEqual({ handler: "Profile", componentPath: "Profile" });
    expect(await rendered(`<Route path="/a" Component={Account} />`))
      .toEqual({ handler: "Account", componentPath: "Account" });
    expect(await rendered(`<Route path="/users/:id" element={<UserCard />} />`))
      .toEqual({ handler: "UserCard", componentPath: "UserCard" });
    expect(await rendered(`<Route path="/d" element={<Dashboard></Dashboard>} />`))
      .toEqual({ handler: "Dashboard", componentPath: "Dashboard" });
    expect(await rendered(`<Route path="/r" render={(props) => <Report {...props} />} />`))
      .toEqual({ handler: "Report", componentPath: "Report" });
  });

  it("unwraps a single-child wrapper and an HOC, and follows a lazy import", async () => {
    expect(await rendered(`<Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />`))
      .toEqual({ handler: "AdminPage", componentPath: "AdminPage" });
    expect(await rendered(`<Route path="/s" element={<Suspense fallback={<Spinner />}><Settings /></Suspense>} />`))
      .toEqual({ handler: "Settings", componentPath: "Settings" });
    expect(await rendered(`<Route path="/p" component={withRouter(Profile)} />`))
      .toEqual({ handler: "Profile", componentPath: "Profile" });
    expect(await rendered(`<Route path="/c" component={connect(mapState)(Cart)} />`))
      .toEqual({ handler: "Cart", componentPath: "Cart" });
    expect(await rendered(`<Route path="/l" component={lazy(() => import("./pages/Login"))} />`))
      .toEqual({ handler: "Login", componentPath: "./pages/Login" });
  });

  it("reads the v5 children form, but not a nested <Route> as the page", async () => {
    expect(await rendered(`<Route path="/x"><Editor /></Route>`))
      .toEqual({ handler: "Editor", componentPath: "Editor" });
    const nested = await routesOf(`const r = (<Route path="/admin"><Route path="users" element={<Users />} /></Route>);`);
    expect(nested.find((r) => r.path === "/admin")?.componentPath).toBeNull();
    expect(nested.find((r) => r.path === "/admin/users")?.componentPath).toBe("Users");
  });

  it("names nothing when the route renders no single component", async () => {
    // Intrinsic markup, a conditional, several siblings: no guess.
    expect((await rendered(`<Route path="/" element={<h1>Welcome</h1>} />`)).componentPath).toBeNull();
    expect((await rendered(`<Route path="/s" element={isSeller ? <SellerLayout /> : <SellerLogin />} />`)).componentPath).toBeNull();
    expect((await rendered(`<Route path="/l" element={<Layout><Header /><Page /></Layout>} />`)).componentPath).toBeNull();
    expect((await rendered(`<Route path="/q" element={<Pages.Profile />} />`)).componentPath).toBeNull();
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
    expect(paths).toEqual(expect.arrayContaining(["/", "/old", "/shop", "/shop/cart"]));
  });

  it("ignores trees, docs entries and computed paths that only look like routes", async () => {
    const src = `export const menu = [{ path: "/docs", children: [{ path: "intro", label: "Intro" }] }];
export const catalog = [{ path: "/button", component: "Button" }];
const items = list.map((r) => ({ path: '/' + r.path, component: Page }));`;
    expect(await routesOf(src, "data.ts")).toHaveLength(0);
  });

  it("composes nested children under their parent's path", async () => {
    const src = `export const routes = [
  { path: "/user/:id", component: User, children: [
    { path: "profile", component: Profile },
    { path: "/absolute", component: Abs },
    { path: "settings", children: [{ path: "email", component: Email }] },
  ] },
  { path: "", component: Layout, children: [{ path: "dashboard", component: Dash }] },
];`;
    const paths = (await routesOf(src, "router.ts")).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/user/:id/profile", "/absolute", "/user/:id/settings/email", "dashboard"]));
  });
});

describe("React Router data routers", () => {
  it("reads createBrowserRouter objects: element, Component, lazy, index, pathless layouts", async () => {
    const src = `import { createBrowserRouter } from "react-router-dom";
import { Home } from "./pages/Home";
const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "/orders", Component: Orders, loader: ordersLoader },
      { path: "/orders/:id", lazy: () => import("./pages/OrderDetail") },
      { path: "/admin", element: <RequireAdmin><AdminLayout /></RequireAdmin>, children: [
        { index: true, element: <AdminHome /> },
        { path: "users", element: <Users /> },
      ] },
    ],
  },
]);`;
    const rows = (await routesOf(src, "router.tsx")).map((r) => [r.path, r.handler, r.componentPath]);
    expect(rows).toEqual(expect.arrayContaining([
      ["/", "Home", "Home"],
      ["/orders", "Orders", "Orders"],
      ["/orders/:id", "OrderDetail", "./pages/OrderDetail"],
      ["/admin", "AdminLayout", "AdminLayout"],
      ["/admin", "AdminHome", "AdminHome"],
      ["/admin/users", "Users", "Users"],
    ]));
    expect(rows.map((r) => r[0])).not.toContain("users");
  });

  it("resolves path constants the file declares, and ignores look-alikes", async () => {
    const src = `export const ROUTES = { home: "/", orders: { list: "/orders" } } as const;
const BASE = "/shop";
export const routes = [
  { path: ROUTES.orders.list, element: <Orders /> },
  { path: \`\${BASE}/cart\`, element: <Cart /> },
  { path: ROUTES.missing, element: <Lost /> },
];
const menu = [{ path: "/docs", element: someNode }, { path: "/x", Component: "Button" }];`;
    const paths = (await routesOf(src, "routes.tsx")).map((r) => r.path);
    // A name this file does not declare stays a hole for the project pass
    // (react-router-resolver.ts), which fills it from an import or drops it.
    expect(paths).toEqual(["/orders", "/shop/cart", "${ROUTES.missing}"]);
  });
});

describe("Angular Router route configs", () => {
  it("extracts { path, component } eager routes", async () => {
    const src = `export const routes = [
  { path: 'users', component: UserListComponent },
  { path: 'users/:id', component: UserDetailComponent },
];`;
    const routes = await routesOf(src, "app.routes.ts");
    const byPath = new Map(routes.map((r) => [r.path, r]));
    expect(byPath.get("users")?.handler).toBe("UserListComponent");
    expect(byPath.get("users/:id")?.handler).toBe("UserDetailComponent");
  });

  it("extracts lazy loadComponent routes, taking the class from the .then()", async () => {
    const src = `export const routes = [
  { path: 'admin', loadComponent: () => import('./admin/admin.component').then(m => m.AdminComponent) },
  { path: 'reports', loadChildren: () => import('./reports/reports.routes').then(m => m.REPORTS) },
];`;
    const routes = await routesOf(src, "app.routes.ts");
    const admin = routes.find((r) => r.path === "admin");
    expect(admin?.handler).toBe("AdminComponent");
    expect(admin?.componentPath).toBe("./admin/admin.component");
    expect(routes.some((r) => r.path === "reports")).toBe(true);
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

describe("redirect-only routes", () => {
  const rows = async (src: string) =>
    (await routesOf(src)).map((r) => `${r.path} ${r.componentPath ?? "-"} ${r.redirectTo === undefined ? "page" : `→ ${r.redirectTo || "(computed)"}`}`);

  it("React Router: <Navigate> and <Redirect> are redirects, in JSX and in object routes", async () => {
    expect(await rows(`export const App = () => (
  <Routes>
    <Route path="/" element={<Navigate to="/home" replace />} />
    <Route path="/home" element={<Home />} />
    <Route path="/v5" render={() => <Redirect to={next} />} />
  </Routes>
);
export const router = createBrowserRouter([
  { path: "/old", element: <Navigate to="/home" /> },
  { path: "/start", element: <Home /> },
]);`)).toEqual([
      "/ - → /home",
      "/home Home page",
      "/v5 - → (computed)",
      "/old - → /home",
      "/start Home page",
    ]);
  });

  it("Vue and Angular: a bare redirect is wiring, a component with a default-child redirect is a page", async () => {
    expect(await rows(`export default createRouter({ routes: [
  { path: "/", redirect: "/home" },
  { path: "/legacy/:id", redirect: (to) => ({ path: "/home" }) },
  { path: "/settings", component: Settings, redirect: "/settings/profile" },
] });
export const routes: Routes = [{ path: "", redirectTo: "home", pathMatch: "full" }, { path: "home", component: HomeComponent }];`)).toEqual([
      "/ - → /home",
      "/legacy/:id - → (computed)",
      "/settings Settings page",
      " - → home",
      "home HomeComponent page",
    ]);
  });
});
