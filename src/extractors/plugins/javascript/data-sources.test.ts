import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * Real Vue/React data layers hoist endpoints into module consts
 * (`const url = import.meta.env.VITE_X ?? '/site/cui_cart_json'`) and call
 * `fetch(url)`. The extractor only captured a string/template *literal*
 * argument, so these calls carried no URL and never joined to a backend route
 * (photo-booth: apiRouteLinks was 4). Resolving file-local URL consts is the fix.
 */
async function apiCallsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

async function dbOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
}

describe("JS ORM read/write classification (access)", () => {
  it("tags write verbs as write and finders as read", async () => {
    const ds = await dbOf(`
      async function f() {
        await prisma.user.findMany();
        await prisma.user.create({ data });
        await userRepo.save(user);
      }`);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d.access]));
    expect(byName["prisma.user.findMany"]).toBe("read");
    expect(byName["prisma.user.create"]).toBe("write");
    expect(byName["userRepo.save"]).toBe("write");
  });
});

describe("JS api-call URL const resolution", () => {
  it("resolves a bare identifier fetch arg via an env-default const", async () => {
    const SRC = `const checkoutUrl = import.meta.env.VITE_CHECKOUT_URL ?? '/site/cui_checkout_json';
async function go() { await fetch(checkoutUrl, { method: 'POST' }); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls.map((c) => c.target)).toContain("/site/cui_checkout_json");
  });

  it("substitutes a ${const} interpolation in a template URL", async () => {
    const SRC = `const galleryUrl = '/site/cui_gallery_detail_json';
async function go(ownerId: number) { await fetch(\`\${galleryUrl}?ownerCustomerId=\${ownerId}\`); }`;
    const calls = await apiCallsOf(SRC);
    // Leading const resolves; the unresolved ${ownerId} query is dropped by the
    // cross-tier path normalizer, so this joins to /site/cui_gallery_detail_json.
    expect(calls[0]!.target).toBe("/site/cui_gallery_detail_json?ownerCustomerId=${ownerId}");
  });

  it("resolves a concatenation-built const URL (the old literal-only gap)", async () => {
    // `base + '/api/users/' + id` — the previous folder mishandled `+` and
    // produced a mangled partial; the symbolic resolver reduces each runtime
    // part to `{}` and strips the leading unknown base → an app-relative path
    // that joins `/api/users/:id`.
    const SRC = `function go(base, id) {
  const url = base + '/api/users/' + id;
  return fetch(url);
}`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/users/{}");
  });

  it("resolves an env-base concat const and records the env var in baseEnv", async () => {
    const SRC = `const url = import.meta.env.VITE_API + '/orders';
async function go() { await fetch(url); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/orders");
    expect(calls[0]!.baseEnv).toBe("VITE_API");
  });

  it("chases a const-to-const base multi-hop", async () => {
    const SRC = `const base = '/api/v2';
const url = base + '/users';
async function go() { await fetch(url); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/v2/users");
  });

  it("still captures a literal URL and leaves an unresolved template unchanged", async () => {
    const lit = await apiCallsOf(`fetch('/api/users');`);
    expect(lit[0]!.target).toBe("/api/users");
    // No URL const in scope → template reproduced verbatim (no fixture churn).
    const tpl = await apiCallsOf("function f(base){ return fetch(`${base}/users`); }");
    expect(tpl[0]!.target).toBe("${base}/users");
  });

  it("does not treat `<name>Router.post('/x', handler)` route defs as outbound calls", async () => {
    // Express route files name the router `productRouter`/`userRouter` and pass an
    // imported handler identifier, so neither the literal-`router` name nor the
    // inline-function heuristic caught them → the whole route file was mis-read as
    // outbound api-calls (greencart: 17 phantom calls). The `*Router`/`*Route`
    // receiver convention fixes it.
    const SRC = `productRouter.post("/add", authSeller, addProduct);
productRouter.get("/list", productList);
userRoute.delete("/:id", removeUser);`;
    expect(await apiCallsOf(SRC)).toHaveLength(0);
  });

  it("still captures a genuine client call whose receiver isn't router-shaped", async () => {
    const calls = await apiCallsOf(`apiClient.get("/api/products");`);
    expect(calls.map((c) => c.target)).toContain("/api/products");
  });

  it("does not map non-URL string consts (keeps the map an endpoint table)", async () => {
    const SRC = `const label = 'checkout';
async function go() { await fetch(label); }`;
    // `label` isn't URL-shaped, so it never enters the const map and the call is
    // dropped rather than emitting a bogus api-call.
    expect(await apiCallsOf(SRC)).toHaveLength(0);
  });

  // Real MERN/Vite frontends build their base from the environment inside a
  // template: `const API_URL = `${import.meta.env.VITE_API_URL || ""}/api/admin``,
  // then `fetch(`${API_URL}/donors`)`. The `||`/`??` default collapses to a
  // string so the whole const resolves, and the call substitutes it.
  it("resolves an env-base template const and substitutes it into a call", async () => {
    const SRC = `const API_URL = \`\${import.meta.env.VITE_API_URL || ""}/api/admin\`;
async function go() { await fetch(\`\${API_URL}/donors\`); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/admin/donors");
  });

  it("resolves an env-base template const used as a bare fetch arg", async () => {
    const SRC = `const API_URL = \`\${import.meta.env.VITE_API_URL ?? ""}/api/auth/register\`;
async function go() { await fetch(API_URL, { method: "POST" }); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/auth/register");
  });

  it("resolves a template with a leading runtime base to an app-relative path", async () => {
    // `base` is a runtime parameter (an unknown leading base). The symbolic
    // value resolver folds it to a `{}` hole, then strips that leading base so
    // the path is app-relative and joinable — where the old literal-only folder
    // dropped the call entirely.
    const SRC = `function f(base) { const u = \`\${base}/api/x\`; return fetch(u); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("/api/x");
  });
});

/**
 * DOM / JS-builtin manipulation shares verb names with ORM CRUD (`.remove()`,
 * `.values()`, `.get()`, `.update()`), so on vanilla-JS/DOM frontends the ORM
 * heuristic used to invent phantom data entities. The Food-order site's only
 * "data access" was `navbar.classList.remove` → a bogus `classList` entity. A
 * DOM/builtin receiver denylist (+ rejecting fluent builtin chains) fixes it.
 */
async function dbSourcesOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
}

describe("JS ORM detection rejects DOM/builtin noise", () => {
  it("does not treat classList/style/dataset .remove as a DB op", async () => {
    expect(await dbSourcesOf(`navbar.classList.remove("open");`)).toHaveLength(0);
    expect(await dbSourcesOf(`el.style.removeProperty("x"); panel.dataset.delete;`)).toHaveLength(0);
  });

  it("does not treat document/window/localStorage chains as DB ops", async () => {
    expect(await dbSourcesOf(`document.querySelector("#x").classList.remove("y");`)).toHaveLength(0);
    expect(await dbSourcesOf(`localStorage.delete; window.history.delete;`)).toHaveLength(0);
  });

  it("does not treat a fluent builtin chain (a call in the receiver) as a DB op", async () => {
    expect(await dbSourcesOf(`const t = str.toLowerCase().split(" ").map(w => w).join(" ");`)).toHaveLength(0);
  });

  it("still recognises a genuine ORM call", async () => {
    const db = await dbSourcesOf(`async function go() { return prisma.user.findMany(); }`);
    expect(db.map((d) => d.name)).toContain("prisma.user.findMany");
  });
});

/**
 * Mongoose (and Sequelize/TypeORM) statics are the data layer of the typical
 * MERN backend, but the core finder/mutator verbs were absent from ORM_METHODS:
 * `Product.find({})`, `Product.findById(id)`, `Product.findByIdAndUpdate(...)`,
 * `Address.find({userId})` produced NO data source — controllers only resolved
 * for `User.*`/`Order.*` because those names happened to be hardcoded ORM roots.
 * The fix adds the finder/mutator family + a model-like-receiver gate for the
 * Array-colliding bare `find` (greencart: symbolDataAccess 9 → all controller
 * queries).
 */
describe("JS ORM detection recognises Mongoose model statics", () => {
  it("treats Model.find on a PascalCase model receiver as a DB op", async () => {
    const db = await dbSourcesOf(`async function go() { return Product.find({}); }`);
    expect(db.map((d) => d.name)).toContain("Product.find");
  });

  it("recognises the findById / findByIdAndUpdate family on any model", async () => {
    const names = (await dbSourcesOf(
      `async function go(id) {
         await Product.findById(id);
         await Product.findByIdAndUpdate(id, { inStock: true });
         await Address.find({ userId: 1 });
         await User.findOneAndDelete({ id });
       }`,
    )).map((d) => d.name);
    expect(names).toContain("Product.findById");
    expect(names).toContain("Product.findByIdAndUpdate");
    expect(names).toContain("Address.find");
    expect(names).toContain("User.findOneAndDelete");
  });

  it("recognises countDocuments / deleteOne / insertMany / updateOne", async () => {
    const names = (await dbSourcesOf(
      `async function go() {
         await Order.countDocuments();
         await Order.deleteOne({ _id });
         await Order.insertMany(rows);
         await Order.updateOne({ _id }, patch);
       }`,
    )).map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Order.countDocuments", "Order.deleteOne", "Order.insertMany", "Order.updateOne",
      ]),
    );
  });

  it("catches the model find inside a fluent populate/sort chain", async () => {
    // The inner `Order.find(...)` is the DB op; the outer .populate/.sort are
    // chain noise. The model entity still attributes via the inner call.
    const db = await dbSourcesOf(
      `async function go() { return Order.find({ userId }).populate("items").sort({ createdAt: -1 }); }`,
    );
    expect(db.map((d) => d.name)).toContain("Order.find");
  });

  it("does NOT treat Array.prototype.find on a plain collection as a DB op", async () => {
    expect(await dbSourcesOf(`const u = users.find(u => u.id === id);`)).toHaveLength(0);
    expect(await dbSourcesOf(`const u = state.users.find(u => u.id === id);`)).toHaveLength(0);
  });

  it("does NOT treat .find(predicate) on a PascalCase-named array as a DB op", async () => {
    // A React state array can be PascalCase (`const Product = useContext(...)`), so
    // `Product.find(p => p._id === id)` is Array.find, not a query — the function
    // first-arg vetoes it (greencart: AppContext/Cart/ProductDetail were false hits).
    expect(await dbSourcesOf(`const p = Product.find((item) => item._id === id);`)).toHaveLength(0);
    // ...but a real query filter (object / id / none) is still a DB op.
    expect((await dbSourcesOf(`Product.find({ inStock: true });`)).map((d) => d.name)).toContain("Product.find");
  });

  it("does NOT treat find/all on a PascalCase JS builtin as a DB op", async () => {
    expect(await dbSourcesOf(`const xs = Array.from(items); await Promise.all(ps);`)).toHaveLength(0);
  });
});

/**
 * URL-builder helper calls: real Vue/React data layers funnel every request
 * through a helper (`axios.get(requestUri('teamtalk','v4'))`). The verb's
 * URL argument is a call expression, not a literal — captured verbatim so a
 * project-level pass can substitute the helper's template (league-planner: 187 of 190
 * axios calls were dropped before this).
 */
describe("JS api-call call-expression URL arg", () => {
  it("captures a helper call on a client member receiver (axios.get)", async () => {
    const calls = await apiCallsOf(`async function go() { return axios.get(requestUri('teamtalk', 'v4')); }`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("requestUri('teamtalk', 'v4')");
  });

  it("captures a helper call wrapped in a template literal (whitespace collapsed)", async () => {
    const calls = await apiCallsOf("async function go(id) { return axios.delete(`${requestUri('teamtalk', 'v4')}/${id}`); }");
    expect(calls[0]!.target).toBe("${requestUri('teamtalk', 'v4')}/${id}");
  });

  it("does NOT treat a local data-fetcher fetchX(localArg) as an HTTP call", async () => {
    // `fetchLineup` matches the fuzzy isHttpRoot ('fetch') but is a local
    // function taking a non-URL argument — a call-expression arg needs a strict
    // HTTP signal (exact root or a client member receiver), so it's rejected.
    expect(await apiCallsOf(`function go() { return fetchLineup(ids.map((s) => s.id)); }`)).toHaveLength(0);
  });

  it("still captures fetch(helper()) — fetch is an exact client root", async () => {
    const calls = await apiCallsOf(`async function go() { return fetch(adminUri('license/product')); }`);
    expect(calls[0]!.target).toBe("adminUri('license/product')");
  });
});

describe("JS api-call — `del` is the DELETE verb", () => {
  // `delete` is a reserved word, so superagent, koa-route and the clients that
  // wrap them expose DELETE as `del`. Leaving it out of the verb set dropped
  // every DELETE call in a codebase silently: the accuracy eval found all four
  // of the RealWorld frontend's DELETEs missing while `get`/`post`/`put`
  // resolved, at precision 1.000 — a pure blind spot, not a wrong answer.
  it("captures a del() call with a URL-shaped argument", async () => {
    const calls = await apiCallsOf(`
      const requests = {
        del: url => superagent.del(\`\${API_ROOT}\${url}\`).then(body),
        get: url => superagent.get(\`\${API_ROOT}\${url}\`).then(body),
      };
      const Articles = {
        del: slug => requests.del(\`/articles/\${slug}\`),
        get: slug => requests.get(\`/articles/\${slug}\`),
      };`);
    const targets = calls.map((c) => c.target);
    expect(targets).toContain("/articles/${slug}");
    // The `del` and `get` wrappers both resolve — the point is that they agree.
    expect(calls.filter((c) => c.name === "del").length).toBeGreaterThan(0);
  });

  it("still requires a URL-shaped argument, so `set.del(id)` is not an API call", async () => {
    const calls = await apiCallsOf(`
      function f(ids) { cache.del(id); }`);
    expect(calls).toHaveLength(0);
  });
});
