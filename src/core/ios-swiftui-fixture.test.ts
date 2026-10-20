import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-ios-swiftui, against the screens and models its README labels by hand. */
const fixture = resolve("test-fixtures/sample-ios-swiftui");

describe.skipIf(!existsSync(fixture))("sample-ios-swiftui", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-swiftui-"));
    out = join(dir, "sample-ios-swiftui");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes every view a navigation opens a screen, with the views it opens", async () => {
    const s = await loadReportSummary(out);
    const screens = new Map(s.screens.map((x) => [x.routePath, x]));
    expect([...screens.keys()].sort()).toEqual(["AddItemView", "ItemDetailView", "ItemListView", "RootTabs", "SettingsView"]);
    expect(screens.get("RootTabs")?.navigatesTo).toEqual(["ItemListView", "SettingsView"]);
    expect(screens.get("ItemListView")?.navigatesTo).toEqual(["ItemDetailView", "AddItemView"]);
    expect(screens.get("ItemDetailView")?.filePath).toBe("Notes/Views/ItemDetailView.swift");
  });

  it("reads SwiftData models — stored fields only — and where views read and write them", async () => {
    const s = await loadReportSummary(out);
    const fields = (s.entityGraph?.nodes ?? []).find((n) => n.name === "Item")?.columns?.map((f) => f.name);
    expect(fields).toEqual(["name", "createdAt", "notes"]);
    expect((s.entityGraph?.edges ?? []).length).toBe(1);
    const edges = (s.dataAccessGraph?.edges ?? []).map((e) => `${e.source} -> ${e.target}`);
    expect(edges).toContain("file::Notes/Views/ItemListView.swift -> entity::Item::Item");
    expect(edges.some((e) => e.startsWith("file::Notes/Views/AddItemView.swift -> ") && e.includes("Item"))).toBe(true);
  });
});
