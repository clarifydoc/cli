import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * React Router v6 routes on `test-fixtures/sample-react-data-router`, against
 * the labels in its README — written by hand from its source: a data router
 * with an index route under a pathless layout, imported path constants, a
 * lazy route, an array `.map`ped into <Route> from another file, route
 * objects listed by name under a spread parent, and descendant <Routes>
 * under a splat mount and a plain one.
 */
describe("frontend routes — sample-react-data-router", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-react-router-"));
    await analyze({ projectRoot: resolve(__dirname, "../../test-fixtures/sample-react-data-router"), outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("places every labelled route at its declaration, and no other", () => {
    const rows = summary.routeMap.filter((r) => r.kind === "frontend").map((r) => `${r.path} ${r.filePath}:${r.line}`).sort();
    expect(rows).toEqual([
      "/ src/main.tsx:16",
      "/admin src/admin/AdminRoutes.tsx:9",
      "/admin/* src/App.tsx:13",
      "/admin/users src/admin/AdminRoutes.tsx:10",
      "/help src/App.tsx:14",
      "/help/faq src/help/HelpRoutes.tsx:8",
      "/menu src/menu.ts:6",
      "/orders src/main.tsx:17",
      "/orders/:id src/main.tsx:18",
      "/settings src/main.tsx:10",
      "/settings/billing src/settings/routes.tsx:6",
      "/settings/profile src/settings/routes.tsx:5",
      "/specials src/menu.ts:7",
    ]);
  });

  it("joins each route to the page it renders", () => {
    const pages = Object.fromEntries((summary.screens ?? []).filter((s) => s.routePath).map((s) => [s.routePath, s.filePath]));
    expect(pages).toMatchObject({
      "/": "src/pages/Home.tsx",
      "/orders": "src/pages/Orders.tsx",
      "/orders/:id": "src/pages/OrderDetail.tsx",
      "/menu": "src/pages/MenuPage.tsx",
      "/specials": "src/pages/SpecialsPage.tsx",
      "/admin": "src/admin/AdminHome.tsx",
      "/admin/users": "src/admin/Users.tsx",
      "/settings/profile": "src/settings/Profile.tsx",
      "/help/faq": "src/help/Faq.tsx",
    });
  });
});
