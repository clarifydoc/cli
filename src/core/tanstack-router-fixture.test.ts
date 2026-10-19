import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-tanstack-router, against the routes its README labels by hand. */
const fixture = resolve("test-fixtures/sample-tanstack-router");

describe.skipIf(!existsSync(fixture))("sample-tanstack-router", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-tanstack-"));
    out = join(dir, "sample-tanstack-router");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("routes every file route and code route as labelled, and no layout", async () => {
    const s = await loadReportSummary(out);
    const routes = s.routeMap.filter((r) => r.kind === "frontend" && r.filePath !== "index.html").map((r) => `${r.path} ${r.filePath}`);
    expect(routes.sort()).toEqual([
      "/ src/routes/index.tsx",
      "/about src/code-router.tsx",
      "/dashboard src/routes/_auth.dashboard.tsx",
      "/files/* src/routes/files.$.tsx",
      "/posts/:postId src/routes/posts.$postId.tsx",
      "/settings src/routes/settings/index.tsx",
      "/users/:userId src/code-router.tsx",
    ].sort());
  });

  it("makes each route's page the screen: the route file, or the component it names", async () => {
    const s = await loadReportSummary(out);
    const screens = new Map(s.screens.map((x) => [x.filePath, x.routePath]));
    expect(screens.get("src/routes/posts.$postId.tsx")).toBe("/posts/:postId");
    expect(screens.get("src/pages/Settings.tsx")).toBe("/settings");
    expect(screens.get("src/pages/About.tsx")).toBe("/about");
    expect(screens.get("src/pages/User.tsx")).toBe("/users/:userId");
  });

  it("detects the router and keeps its route files alive without the generated tree", async () => {
    const s = await loadReportSummary(out);
    expect(s.detectedFrameworks.map((f) => f.name)).toContain("TanStack Router");
    expect((s.deadCode?.files ?? []).map((f) => f.filePath)).toEqual([]);
  });
});
