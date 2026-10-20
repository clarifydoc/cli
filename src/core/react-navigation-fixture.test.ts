import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-react-navigation, against the screens its README labels by hand. */
const fixture = resolve("test-fixtures/sample-react-navigation");

describe.skipIf(!existsSync(fixture))("sample-react-navigation", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-rn-"));
    out = join(dir, "sample-react-navigation");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes each navigator screen a screen on its component file, named as navigate() names it", async () => {
    const s = await loadReportSummary(out);
    const screens = new Map(s.screens.filter((x) => x.routePath).map((x) => [x.routePath, x]));
    expect([...screens.keys()].sort()).toEqual(["About", "Details", "Home", "Profile", "Settings"]);
    expect(screens.get("Home")?.filePath).toBe("app/src/screens/HomeScreen.tsx");
    expect(screens.get("Profile")?.filePath).toBe("app/src/screens/ProfileScreen.tsx");
    expect(screens.get("Settings")?.filePath).toBe("app/src/SettingsTabs.tsx");
    expect(screens.get("Home")?.navigatesTo.sort()).toEqual(["Details", "Settings"]);
  });

  it("links the screens' calls to the API", async () => {
    const s = await loadReportSummary(out);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} -> ${l.routePath}`).sort()).toEqual([
      "app/src/screens/DetailsScreen.tsx GET -> /api/items/:id",
      "app/src/screens/HomeScreen.tsx GET -> /api/items",
    ]);
  });
});
