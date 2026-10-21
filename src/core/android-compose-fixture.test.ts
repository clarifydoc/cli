import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-android-compose, against its README's labels. */
const fixture = resolve("test-fixtures/sample-android-compose");

describe.skipIf(!existsSync(fixture))("sample-android-compose", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-compose-"));
    out = join(dir, "sample-android-compose");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes each NavHost destination a screen on the composable it renders, through the package import", async () => {
    const s = await loadReportSummary(out);
    expect(s.screens.filter((x) => !x.filePath.includes("/legacy/")).map((x) => `${x.routePath} ${x.filePath}`).sort()).toEqual([
      "home app/src/main/java/com/acme/app/ui/HomeScreen.kt",
      "profile app/src/main/java/com/acme/app/ui/ProfileScreen.kt",
    ]);
  });

  it("makes Activities and Fragments screens by the base-class chain, with the screens they open — through the navigation graph too", async () => {
    const s = await loadReportSummary(out);
    const legacy = s.screens.filter((x) => x.filePath.includes("/legacy/")).map((x) => `${x.name} → ${[...x.navigatesTo].sort().join(", ")}`).sort();
    expect(legacy).toEqual([
      "CarsActivity → GarageFragment, ReceiptActivity",
      "DoneFragment → GarageFragment",
      "GarageFragment → PaymentFragment",
      "PaymentFragment → DoneFragment",
      "ReceiptActivity → ",
    ]);
    // An id no graph declares leaves no row behind.
    expect(s.routeMap.some((r) => r.path.includes("help_dialog") || r.path.startsWith("@"))).toBe(false);
  });
});
