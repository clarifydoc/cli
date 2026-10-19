import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-remix-app, against the routes its README labels by hand. */
const fixture = resolve("test-fixtures/sample-remix-app");

describe.skipIf(!existsSync(fixture))("sample-remix-app", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-remix-"));
    out = join(dir, "sample-remix-app");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("routes each Remix flat-routes module as labelled, and no layout or helper module", async () => {
    const s = await loadReportSummary(out);
    const remix = s.routeMap.filter((r) => r.projectId === "remix").map((r) => `${r.httpMethod ?? ""} ${r.path} ${r.filePath!.replace("remix/app/routes/", "")}`.trim());
    expect(remix.sort()).toEqual([
      "/ _index.tsx",
      "/:lang?/docs ($lang).docs.tsx",
      "/about about.tsx",
      // The layout and its index share /concerts; route identity keeps one row (the layout's own is below).
      "/concerts concerts._index.tsx",
      "/concerts/:city concerts.$city/route.tsx",
      "/concerts/mine concerts_.mine.tsx",
      "/files/* files.$.tsx",
      "/login _auth.login.tsx",
      "GET /api/orders api.orders.ts",
      "GET /sitemap.xml sitemap[.]xml.tsx",
      "POST /api/orders api.orders.ts",
    ].sort());
    const layout = JSON.parse(await readFile(join(out, "remix/app/routes/concerts.tsx.json"), "utf8"));
    expect(layout.routes.map((r: { path: string }) => r.path)).toEqual(["/concerts"]);
    expect(JSON.parse(await readFile(join(out, "remix/app/routes/_auth.tsx.json"), "utf8")).routes).toEqual([]);
  });

  it("reads React Router 7's routes.ts, each route opening its page", async () => {
    const s = await loadReportSummary(out);
    const rr7 = s.routeMap.filter((r) => r.projectId === "rr7").map((r) => r.path);
    expect(rr7).toEqual(["/", "/about", "/login", "/concerts", "/concerts/:city", "/account", "/account/settings"]);
    const pages = Object.fromEntries(s.screens.filter((x) => x.filePath.startsWith("rr7/")).map((x) => [x.routePath, x.filePath]));
    expect(pages).toEqual({
      "/": "rr7/app/routes/home.tsx",
      "/about": "rr7/app/routes/about.tsx",
      "/login": "rr7/app/routes/login.tsx",
      "/concerts": "rr7/app/routes/concerts/home.tsx",
      "/concerts/:city": "rr7/app/routes/concerts/city.tsx",
      "/account": "rr7/app/routes/account.tsx",
      "/account/settings": "rr7/app/routes/settings.tsx",
    });
  });
});
