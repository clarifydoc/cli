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
        await prisma.player.findMany();
        await prisma.player.create({ data });
        await playerRepo.save(player);
      }`);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d.access]));
    expect(byName["prisma.player.findMany"]).toBe("read");
    expect(byName["prisma.player.create"]).toBe("write");
    expect(byName["playerRepo.save"]).toBe("write");
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
    // `base + '/api/players/' + id` — the previous folder mishandled `+` and
    // produced a mangled partial; the symbolic resolver reduces each runtime
    // part to `{}` and strips the leading unknown base → an app-relative path
    // that joins `/api/players/:id`.
    const SRC = `function go(base, id) {
  const url = base + '/api/players/' + id;
  return fetch(url);
}`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/players/{}");
  });

  it("resolves an env-base concat const and records the env var in baseEnv", async () => {
    const SRC = `const url = import.meta.env.VITE_API + '/cars';
async function go() { await fetch(url); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/cars");
    expect(calls[0]!.baseEnv).toBe("VITE_API");
  });

  it("chases a const-to-const base multi-hop", async () => {
    const SRC = `const base = '/api/v2';
const url = base + '/players';
async function go() { await fetch(url); }`;
    const calls = await apiCallsOf(SRC);
    expect(calls[0]!.target).toBe("/api/v2/players");
  });

  it("still captures a literal URL and leaves an unresolved template unchanged", async () => {
    const lit = await apiCallsOf(`fetch('/api/players');`);
    expect(lit[0]!.target).toBe("/api/players");
    // No URL const in scope → template reproduced verbatim (no fixture churn).
    const tpl = await apiCallsOf("function f(base){ return fetch(`${base}/players`); }");
    expect(tpl[0]!.target).toBe("${base}/players");
  });

  it("does not treat `<name>Router.post('/x', handler)` route defs as outbound calls", async () => {
    // Express route files name the router `partRouter`/`playerRouter` and pass an
    // imported handler identifier, so neither the literal-`router` name nor the
    // inline-function heuristic caught them → the whole route file was mis-read as
    // outbound api-calls (greencart: 17 phantom calls). The `*Router`/`*Route`
    // receiver convention fixes it.
    const SRC = `partRouter.post("/add", authSeller, addPart);
partRouter.get("/list", partList);
playerRoute.delete("/:id", removePlayer);`;
    expect(await apiCallsOf(SRC)).toHaveLength(0);
  });

  it("does not treat a verb on a router the file makes, or a wrapped handler, as an outbound call", async () => {
    // \`const reports = Router()\` names no router, and \`asyncHandler(async …)\`
    // passes no function directly: both were read as a GET to "/summary".
    const SRC = `const reports = Router();
const app = new Hono<Env>();
reports.get('/summary', asyncHandler(async (req, res) => res.json({})));
app.get('/health', (c) => c.text('ok'));
items.get('/list', catchAsync(function (req, res) { res.end(); }));
const api = axios.create({ baseURL: '/api' });
api.get('/cars');`;
    expect((await apiCallsOf(SRC)).map((c) => c.target)).toEqual(["/cars"]);
  });

  it("names the default instance of a generated SDK call on `(options?.client ?? client)`", async () => {
    const calls = await apiCallsOf(`export const labelsList = (options) => (options?.client ?? client).get({ url: '/labels', ...options });`);
    expect(calls.map((c) => [c.target, c.client])).toEqual([["/labels", "client"]]);
  });

  it("still captures a genuine client call whose receiver isn't router-shaped", async () => {
    const calls = await apiCallsOf(`apiClient.get("/api/parts");`);
    expect(calls.map((c) => c.target)).toContain("/api/parts");
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

  it("does not treat Map/Set .delete on a local collection as a DB op", async () => {
    expect(await dbSourcesOf(`const next = new Set(ids); next.delete(id); this.byId.delete(k); state.freePeriod.delete(p);`)).toHaveLength(0);
  });

  it("still treats .delete with ORM evidence in the chain as a DB op", async () => {
    const names = (await dbSourcesOf(
      `async function go() { await prisma.player.delete({ where: { id } }); await this.playerRepository.delete(id); await ctx.db.delete(players); await Player.delete(id); }`,
    )).map((d) => d.name);
    expect(names).toEqual(["prisma.player.delete", "this.playerRepository.delete", "ctx.db.delete", "Player.delete"]);
  });

  it("still recognises a genuine ORM call", async () => {
    const db = await dbSourcesOf(`async function go() { return prisma.player.findMany(); }`);
    expect(db.map((d) => d.name)).toContain("prisma.player.findMany");
  });
});

/**
 * Mongoose (and Sequelize/TypeORM) statics are the data layer of the typical
 * MERN backend, but the core finder/mutator verbs were absent from ORM_METHODS:
 * `Part.find({})`, `Part.findById(id)`, `Part.findByIdAndUpdate(...)`,
 * `Address.find({playerId})` produced NO data source — controllers only resolved
 * for `User.*`/`Order.*` because those names happened to be hardcoded ORM roots.
 * The fix adds the finder/mutator family + a model-like-receiver gate for the
 * Array-colliding bare `find` (greencart: symbolDataAccess 9 → all controller
 * queries).
 */
describe("JS ORM detection recognises Mongoose model statics", () => {
  it("treats Model.find on a PascalCase model receiver as a DB op", async () => {
    const db = await dbSourcesOf(`async function go() { return Part.find({}); }`);
    expect(db.map((d) => d.name)).toContain("Part.find");
  });

  it("recognises the findById / findByIdAndUpdate family on any model", async () => {
    const names = (await dbSourcesOf(
      `async function go(id) {
         await Part.findById(id);
         await Part.findByIdAndUpdate(id, { inStock: true });
         await Address.find({ playerId: 1 });
         await Player.findOneAndDelete({ id });
       }`,
    )).map((d) => d.name);
    expect(names).toContain("Part.findById");
    expect(names).toContain("Part.findByIdAndUpdate");
    expect(names).toContain("Address.find");
    expect(names).toContain("Player.findOneAndDelete");
  });

  it("recognises countDocuments / deleteOne / insertMany / updateOne", async () => {
    const names = (await dbSourcesOf(
      `async function go() {
         await Car.countDocuments();
         await Car.deleteOne({ _id });
         await Car.insertMany(rows);
         await Car.updateOne({ _id }, patch);
       }`,
    )).map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Car.countDocuments", "Car.deleteOne", "Car.insertMany", "Car.updateOne",
      ]),
    );
  });

  it("catches the model find inside a fluent populate/sort chain", async () => {
    // The inner `Car.find(...)` is the DB op; the outer .populate/.sort are
    // chain noise. The model entity still attributes via the inner call.
    const db = await dbSourcesOf(
      `async function go() { return Car.find({ playerId }).populate("parts").sort({ createdAt: -1 }); }`,
    );
    expect(db.map((d) => d.name)).toContain("Car.find");
  });

  it("does NOT treat Array.prototype.find on a plain collection as a DB op", async () => {
    expect(await dbSourcesOf(`const p = players.find(p => p.id === id);`)).toHaveLength(0);
    expect(await dbSourcesOf(`const p = state.players.find(p => p.id === id);`)).toHaveLength(0);
  });

  it("does NOT treat .find(predicate) on a PascalCase-named array as a DB op", async () => {
    // A React state array can be PascalCase (`const Part = useContext(...)`), so
    // `Part.find(p => p._id === id)` is Array.find, not a query — the function
    // first-arg vetoes it (greencart: AppContext/Cart/ProductDetail were false hits).
    expect(await dbSourcesOf(`const p = Part.find((item) => item._id === id);`)).toHaveLength(0);
    // ...but a real query filter (object / id / none) is still a DB op.
    expect((await dbSourcesOf(`Part.find({ inStock: true });`)).map((d) => d.name)).toContain("Part.find");
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
  // every DELETE call in a codebase silently: hand-labelling found all four
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

describe("JS api-call bindings are resolved in the scope of the call", () => {
  it("gives each method its own `let url` (Kavita's series service)", async () => {
    const calls = await apiCallsOf(`
      class SeriesService {
        wantToRead() {
          let url = '/api/want-to-read/v2';
          return this.httpClient.post(url, {});
        }
        onDeck() {
          let url = '/api/series/on-deck?libraryId=1';
          return this.httpClient.post(url, {});
        }
        updateMatch() {
          let url = '/api/series/update-match';
          return this.httpClient.post(url, {});
        }
      }`);
    expect(calls.map((c) => c.target)).toEqual([
      "/api/want-to-read/v2",
      "/api/series/on-deck?libraryId=1",
      "/api/series/update-match",
    ]);
  });

  it("lets a parameter shadow a module const of the same name", async () => {
    const calls = await apiCallsOf(`
      const url = '/api/default';
      export function load(url) { return fetch(url); }
      export function def() { return fetch(url); }`);
    expect(calls.map((c) => c.target)).toEqual(["/api/default"]);
  });

  it("still finds a module const declared below the function using it", async () => {
    const calls = await apiCallsOf(`
      export function load() { return fetch(ENDPOINT); }
      const ENDPOINT = '/api/items';`);
    expect(calls.map((c) => c.target)).toEqual(["/api/items"]);
  });
});

describe("JS api-call trust: only a real client is believed without a URL", () => {
  it("does not read a query-param read in a test predicate as a GET", async () => {
    const calls = await apiCallsOf(`
      httpTestingController.expectOne((request) =>
        request.params.get('page') === '1' && req.request.params.get('page_size') === '25');
      const p = httpParams.get('tag');`);
    expect(calls).toEqual([]);
  });

  it("does not take a factory's first argument for its URL because its name contains fetch", async () => {
    const calls = await apiCallsOf(`
      export const fetchStatus = createFetchHandler('system.status', '/system/status');
      const comments = useCommentsFetch('core:comments');`);
    expect(calls).toEqual([]);
  });

  it("trusts a verb on a one-hop client receiver, `this.http` included", async () => {
    const calls = await apiCallsOf(`
      class S {
        list() { return this.http.get(this.getResourceUrl()); }
        one() { return apiClient.get(buildUrl('x')); }
        two() { return this.$axios.delete(urlFor(1)); }
      }`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([
      ["get", "this.getResourceUrl()"],
      ["get", "buildUrl('x')"],
      ["delete", "urlFor(1)"],
    ]);
  });

  it("trusts a client name as a method only on a client or global receiver", async () => {
    const calls = await apiCallsOf(`
      navigator.wakeLock.request('screen');
      $.ajax({ url: '/api/a', type: 'GET' });
      window.fetch('/api/b');
      api.request('/api/c');`);
    // `$.ajax` itself takes no URL argument; its descriptor is read by the
    // object branch (`type` is jQuery's method key).
    expect(calls.map((c) => c.target)).toEqual(["/api/a", "/api/b", "/api/c"]);
  });

  it("does not treat an inbound route config as an outbound request", async () => {
    const calls = await apiCallsOf(`
      fastify.route({ method: 'GET', url: '/api/items', handler: listItems });
      fastify.route({ method: 'POST', url: '/api/items', handler });
      axios({ method: 'get', url: '/api/players' });`);
    expect(calls.map((c) => c.target)).toEqual(["/api/players"]);
  });
});

describe("JS request descriptors and positional request()", () => {
  it("reads jQuery's `type` and Node's `path`, but only beside a real verb", async () => {
    const calls = await apiCallsOf(`
      $.ajax({ type: 'POST', url: '/api/a' });
      http.request({ method: 'GET', path: '/api/b' });
      notify({ type: 'success', url: '/docs' });
      this.$router.push({ path: '/players', params: { id } });`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([
      ["post", "/api/a"],
      ["get", "/api/b"],
    ]);
  });

  it("takes the method from the verb a descriptor is handed to (hey-api)", async () => {
    const calls = await apiCallsOf(`
      export const migrate = (options) => (options.client ?? client).post({ url: '/migration/trello/migrate', ...options });`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([["post", "/migration/trello/migrate"]]);
  });

  it("accepts a method-less descriptor passed to a call with request-shaped keys (Radarr)", async () => {
    const calls = await apiCallsOf(`
      const promise = createAjaxRequest({ url: '/calendar', data: { start, end } }).request;
      const key = [{ url: '/api/cache-key' }];
      useThing({ url: '/not/a/request' });`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([["request", "/calendar"]]);
  });

  it("reads the verb first and the URL second in request(VERB, url)", async () => {
    const calls = await apiCallsOf(`
      class A { save() { return this.http.request('POST', '/api/upload', { body }); } }
      http.request('DELETE', \`/api/items/\${id}\`);`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([
      ["post", "/api/upload"],
      ["delete", "/api/items/${id}"],
    ]);
  });

  it("reads a bare request(…) as HTTP only when the file imports it", async () => {
    // VueUse: \`request\` is the wake lock's own function.
    expect(await apiCallsOf(`const { request } = useWakeLock();\nasync function lock() { await request("screen"); }`)).toEqual([]);
    const lib = await apiCallsOf(`import request from "request";\nrequest("https://api.example.com/v1/items");\nrequest("items");`);
    expect(lib.map((c) => c.target)).toEqual(["https://api.example.com/v1/items", "items"]);
    // A project's own XHR wrapper, called verb first.
    const own = await apiCallsOf(`const request = (method, url) => new XMLHttpRequest();\nrequest('POST', \`api/\${url}\`);`);
    expect(own.map((c) => [c.name, c.target])).toEqual([["post", "api/${url}"]]);
  });

  it("unwraps a .replace() on a literal path, keeping its parameter", async () => {
    const calls = await apiCallsOf(`axios({ method: 'GET', url: '/players/{id}'.replace('{id}', String(id)) });`);
    expect(calls.map((c) => c.target)).toEqual(["/players/{id}"]);
  });
});

describe("JS generated OpenAPI clients (openapi-generator typescript-axios)", () => {
  const generated = `
    export const PostV1alpha1ApiAxiosParamCreator = function (configuration?: Configuration) {
      return {
        getPost: async (name: string, options: RawAxiosRequestConfig = {}): Promise<RequestArgs> => {
          assertParamExists('getPost', 'name', name)
          const localVarPath = \`/apis/content.halo.run/v1alpha1/posts/{name}\`
              .replace(\`{\${"name"}}\`, encodeURIComponent(String(name)));
          const localVarUrlObj = new URL(localVarPath, DUMMY_BASE_URL);
          let baseOptions;
          const localVarRequestOptions = { method: 'GET', ...baseOptions, ...options};
          return { url: toPathString(localVarUrlObj), options: localVarRequestOptions };
        },
        deletePost: async (name: string, options: RawAxiosRequestConfig = {}): Promise<RequestArgs> => {
          const localVarPath = \`/apis/content.halo.run/v1alpha1/posts/{name}\`
              .replace(\`{\${"name"}}\`, encodeURIComponent(String(name)));
          const localVarRequestOptions = { method: 'DELETE', ...baseOptions, ...options};
          return { url: toPathString(localVarUrlObj), options: localVarRequestOptions };
        },
      };
    };`;

  it("emits one api-call per operation from the path and method locals", async () => {
    const calls = await apiCallsOf(generated);
    expect(calls.map((c) => [c.name, c.target])).toEqual([
      ["get", "/apis/content.halo.run/v1alpha1/posts/{name}"],
      ["delete", "/apis/content.halo.run/v1alpha1/posts/{name}"],
    ]);
  });

  it("does not count the shared request function a second time", async () => {
    const common = `
      export const createRequestFunction = function (axiosArgs: RequestArgs, globalAxios: AxiosStatic, BASE_PATH: string, configuration?: Configuration) {
        return <T = unknown, R = AxiosResponse<T>>(axios: AxiosInstance = globalAxios, basePath: string = BASE_PATH) => {
          const axiosRequestArgs = {...axiosArgs.options, url: (axios.defaults.baseURL ? '' : configuration?.basePath ?? basePath) + axiosArgs.url};
          return axios.request<T, R>(axiosRequestArgs);
        };
      };`;
    expect(await apiCallsOf(common)).toEqual([]);
  });
});

describe("JS route decorators are not outbound calls", () => {
  it("skips NestJS @Get / @Post decorators", async () => {
    const calls = await apiCallsOf(`
      @Controller('players')
      export class PlayersController {
        @Get('public/:id')
        publicProfile(@Param('id') id: string) { return id; }
        @Post('sync/all')
        sync() { return fetch('/api/remote/sync'); }
      }`);
    expect(calls.map((c) => c.target)).toEqual(["/api/remote/sync"]);
  });
});

describe("JS request factories: a descriptor URL built from a parameter", () => {
  it("reads a ternary's arms and the factory's parameter as a hole (Radarr createFetchHandler)", async () => {
    const calls = await apiCallsOf(`
      export default function createFetchHandler(section, url) {
        return function(getState, payload, dispatch) {
          const { id } = payload;
          const { request } = createAjaxRequest({ url: id == null ? url : \`\${url}/\${id}\`, data: payload, traditional: true });
          return request;
        };
      }`);
    expect(calls.map((c) => [c.name, c.target, c.targetAlternatives])).toEqual([["request", "${url}", ["${url}/${id}"]]]);
  });

  it("reads a shorthand `{ url }` beside a verb", async () => {
    const calls = await apiCallsOf(`
      export function createRemoveItemHandler(section, url) {
        return () => createAjaxRequest({ url, method: 'DELETE' });
      }`);
    expect(calls.map((c) => [c.name, c.target])).toEqual([["delete", "${url}"]]);
  });

  it("does not take a non-parameter variable for a request without a verb", async () => {
    const calls = await apiCallsOf(`function f() { const x = compute(); return track({ url: x, data: 1 }); }`);
    expect(calls).toEqual([]);
  });
});

describe("JS fetch-style calls carry their verb in the options", () => {
  it("reads method from fetch's options and from a wrapped options object", async () => {
    const calls = await apiCallsOf(`
      fetch('/api/cars', { method: 'POST', body });
      oazapfts.fetchJson('/activities', oazapfts.json({ ...opts, method: 'DELETE', body }));
      fetch('/api/cars');
      fetch('/api/x', { method: someVar });
      fetch('/api/y', { headers });
      fetch('/api/z', { ...init });`);
    // No init, or an init literal naming no method: the Fetch standard's GET. A method from a
    // variable or a spread is unknown.
    expect(calls.map((c) => [c.name, c.target])).toEqual([
      ["post", "/api/cars"],
      ["delete", "/activities"],
      ["get", "/api/cars"],
      ["fetch", "/api/x"],
      ["get", "/api/y"],
      ["fetch", "/api/z"],
    ]);
  });
});

describe("openapi-generator wrappers", () => {
  it("does not read `request(this.axios, this.basePath)` as a request to the client", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { JavaScriptDataSourceExtractor } = await import("./data-sources.js");
    const src = `class PostApi { getPost(name) { return PostApiFp(this.configuration).getPost(name).then((request) => request(this.axios, this.basePath)); } }`;
    const tree = await parseSource(src, "typescript" as any, "post-api.ts");
    const rows = new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(rows).toEqual([]);
  });
});

/**
 * A generic verb is a database operation only with evidence: an ORM/driver
 * import, a repository/model-shaped chain, or a model in scope. Chatwoot's
 * Vuex actions, vue-test-utils wrappers and API clients were database rows.
 */
describe("JS ORM rows need ORM evidence", () => {
  it("drops generic verbs on non-model receivers in a file with no ORM", async () => {
    expect(await dbSourcesOf(`import ContactAPI from '../api/contacts';
      export const actions = { async go() { await ContactAPI.create({}); } };`)).toHaveLength(0);
    expect(await dbSourcesOf(`it('x', () => { const items = wrapper.findAll('li'); view.destroy(); });`)).toHaveLength(0);
  });

  it("keeps them when the file imports an ORM or a model", async () => {
    expect((await dbSourcesOf(`import { Sequelize } from 'sequelize';
      async function go() { await item.update({ a: 1 }); }`)).map((d) => d.name)).toContain("item.update");
    expect((await dbSourcesOf(`import Report from '../models/report';
      async function go() { await Report.findAll(); }`)).map((d) => d.name)).toContain("Report.findAll");
  });
});

describe("SWR keys are the request", () => {
  it("reads useSWR's key as a GET of that URL — string, template, or the first element of an array key", async () => {
    const calls = await apiCallsOf(`
      const fetcher = (url: string) => fetch(url).then((r) => r.json());
      export function Profile({ id, token }) {
        const { data } = useSWR("/api/player", fetcher);
        const { data: cars } = useSWR(\`/api/players/\${id}/cars\`, fetcher);
        const { data: me } = useSWRImmutable(["/api/me", token], fetcher);
        return null;
      }
    `);
    expect(calls.filter((c) => c.name === "GET").map((c) => c.target)).toEqual([
      "/api/player",
      "/api/players/${id}/cars",
      "/api/me",
    ]);
  });

  it("leaves a react-query cache key alone — it labels the cache, it is not a URL", async () => {
    const calls = await apiCallsOf(`
      export function Drills() {
        const q = useQuery({ queryKey: ["drills"], queryFn: () => listDrills() });
        const s = useSWR(shouldFetch ? null : undefined, fetcher);
        return null;
      }
    `);
    expect(calls).toEqual([]);
  });
});

describe("raw SQL handed to a driver", () => {
  it("records the table any receiver's query names, read or write", async () => {
    const ds = await dbOf(`
      export async function f(id: number) {
        await pool.query("SELECT id FROM drills WHERE id = $1", [id]);
        await client.query(\`UPDATE drills SET done = true WHERE id = \${id}\`);
        db.prepare("INSERT INTO audit_log (msg) VALUES (?)").run("x");
        await sql.unsafe("DELETE FROM sessions");
      }
    `);
    expect(ds.filter((d) => d.target).map((d) => `${d.access} ${d.target}`)).toEqual([
      "read drills",
      "write drills",
      "write audit_log",
      "write sessions",
    ]);
  });

  it("never reads prose or a non-SQL first argument as a table", async () => {
    const ds = await dbOf(`
      export function g(map: Map<string, string>) {
        map.get("Select a file from the list");
        router.all("/select from here", h);
        cache.query({ where: "players" });
      }
    `);
    expect(ds.filter((d) => d.target)).toEqual([]);
  });
});

describe("JS api-call — a verb on an untrusted receiver needs a request path", () => {
  it("drops collection lookups whose key merely contains a slash", async () => {
    const calls = await apiCallsOf(`
      const cache = new Map<string, number>();
      class Store { private seen: Set<string> = new Set(); has(k: string) { return this.seen.delete(\`a/\${k}\`); } }
      function f(id: string) {
        cache.get("player/1");
        cy.get("[data-test=a/b]");
        searchParams.get("next/page");
      }`);
    expect(calls).toEqual([]);
  });

  it("drops a slash-containing non-path argument on an unknown receiver", async () => {
    const calls = await apiCallsOf(`function f(svc: any) { return svc.get("tools/call"); }`);
    expect(calls).toEqual([]);
  });

  it("keeps rooted, absolute and base-prefixed paths on an unknown receiver", async () => {
    const calls = await apiCallsOf(`
      function f(svc: any, base: string) {
        svc.get("/api/players");
        svc.post("https://example.com/hook");
        svc.delete(\`\${base}/items/1\`);
      }`);
    expect(calls.map((c) => c.name).sort()).toEqual(["delete", "get", "post"]);
  });

  it("keeps a relative path on a trusted client receiver", async () => {
    const calls = await apiCallsOf(`function f() { return apiClient.get("players/1"); }`);
    expect(calls.map((c) => c.target)).toEqual(["players/1"]);
  });
});

describe("JS api-call — path descriptors count only when handed to a client", () => {
  it("does not read route tables and mocks as requests", async () => {
    const calls = await apiCallsOf(`
      export const routes = [{ method: "GET", path: "/players" }, { path: "/items/:id", type: "delete" }];
      register({ method: "POST", path: "/hooks" });`);
    expect(calls).toEqual([]);
  });

  it("keeps Node's http.request({ method, path })", async () => {
    const calls = await apiCallsOf(`import http from "node:http"; http.request({ method: "POST", path: "/api/jobs", host: "x" });`);
    expect(calls.map((c) => c.target)).toEqual(["/api/jobs"]);
  });
});

describe("JS api-call — an aliased Node request takes a path descriptor", () => {
  it("keeps httpRequest({ method, path }) imported from node:http", async () => {
    const calls = await apiCallsOf(`import { request as httpRequest } from "node:http"; httpRequest({ host: "127.0.0.1", path: "/rpc", method: "POST" });`);
    expect(calls.map((c) => c.target)).toEqual(["/rpc"]);
  });
});

describe("JS database — Supabase tables", () => {
  it("reads the table and the access of supabase.from(…)", async () => {
    const ds = await dbOf(`
      const { data } = await supabase.from("games").select("*").eq("id", id);
      await supabase.from('comments').insert({ body });
      const rows = list.from("x");`);
    expect(ds.map((d) => [d.entity, d.access])).toEqual([["games", "read"], ["comments", "write"]]);
  });
});

describe("JS database — SDK clients and vector stores", () => {
  it("does not read an API SDK's calls as database access", async () => {
    const ds = await dbOf(`import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@prisma/client";
const client = new OpenAI();
const mcp = new Client({ name: "x", version: "1" });
const prisma = new PrismaClient();
async function f() {
  await client.embeddings.create({ model: "m", input: "x" });
  await mcp.callTool({ name: "t" });
  await prisma.player.create({ data: {} });
}`);
    expect(ds.map((d) => d.name)).toEqual(["prisma.player.create"]);
  });

  it("reads a Qdrant client's collection operations", async () => {
    const ds = await dbOf(`import { QdrantClient } from "@qdrant/js-client-rest";
const client = new QdrantClient({ url: "http://qdrant:6333" });
async function f() {
  await client.upsert("chunks", { points });
  await client.search("chunks", { vector, limit: 5 });
  await client.createCollection("files", { vectors: { size: 768, distance: "Cosine" } });
}`);
    expect(ds.map((d) => [d.entity, d.access])).toEqual([["chunks", "write"], ["chunks", "read"], ["files", "write"]]);
  });
});

describe("JS database — a vector client returned by a factory", () => {
  it("follows a typed factory to the client it returns", async () => {
    const ds = await dbOf(`import { QdrantClient } from "@qdrant/js-client-rest";
let client: QdrantClient | null = null;
export function getClient(): QdrantClient { return (client ??= new QdrantClient({ url })); }
export async function index(collectionName: string) {
  const qdrant = getClient();
  await qdrant.upsert(collectionName, { points: [] });
}`);
    expect(ds.map((d) => [d.name, d.access])).toEqual([["qdrant.upsert", "write"]]);
  });
});

describe("JS api-call — a URL object built from a path", () => {
  it("reads the path a fetch's new URL(path, origin) was built from", async () => {
    const calls = await apiCallsOf(`
async function getJson(path: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("x", "1");
  return fetch(url.toString(), { headers: {} });
}
async function health() {
  const u = new URL("/api/health", base);
  return fetch(u.href);
}`);
    expect(calls.map((c) => c.target)).toEqual(["${path}", "/api/health"]);
  });
});

describe("JS api-call — the body a call sends", () => {
  it("types an object literal body from its values, through JSON.stringify and a local const", async () => {
    const calls = await apiCallsOf(`
async function save(name: string, extra: object) {
  await axios.post("/api/players", { name, age: 3, score: 1.5, admin: false, tags: ["a"], address: { city: "x" } });
  const dto = { title: "t", ...extra };
  await fetch("/api/games", { method: "POST", body: JSON.stringify(dto) });
  await axios.get("/api/players", { params: { q: 1 } });
  await http.request({ method: "PUT", url: "/api/items/1", data: { qty: 2 } });
}`);
    const body = Object.fromEntries(calls.map((c) => [`${c.name} ${c.target}`, c.requestBody]));
    expect(body["post /api/players"]).toEqual({
      type: "object",
      properties: {
        name: {}, age: { type: "integer" }, score: { type: "number" }, admin: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } }, address: { type: "object", properties: { city: { type: "string" } } },
      },
    });
    expect(body["post /api/games"]).toEqual({ type: "object", properties: { title: { type: "string" } }, additionalProperties: true });
    expect(body["get /api/players"]).toBeUndefined();
    expect(body["put /api/items/1"]).toEqual({ type: "object", properties: { qty: { type: "integer" } } });
  });
});

describe("JS api-call through a local bound to a URL-builder call", () => {
  it("reads the builder call the local holds, as it reads one written inline", async () => {
    const calls = await apiCallsOf(`import axios from 'axios';
import { requestUri } from '@utils/uriUtils';
export const createRematch = async (personId: string, request: R) => {
  const url = requestUri(\`rematches/person/\${personId}\`, 'v3');
  const response = await axios.post(url, request);
  return response.data;
};`);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual(["post requestUri(`rematches/person/${personId}`, 'v3')"]);
  });
});
