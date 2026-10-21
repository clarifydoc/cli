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
    expect([...screens.keys()].sort()).toEqual([
      "AddBallView", "ArchiveDetailViewController", "ArchiveFilterViewController", "ArchiveInfoViewController", "ArchiveListViewController",
      "BallDetailView", "BallListView", "ExportDoneViewController", "ExportViewController", "FormatPickerViewController", "RootTabs", "SettingsView",
    ]);
    expect(screens.get("RootTabs")?.navigatesTo).toEqual(["BallListView", "SettingsView"]);
    expect(screens.get("BallListView")?.navigatesTo).toEqual(["BallDetailView", "AddBallView"]);
    expect(screens.get("BallDetailView")?.filePath).toBe("Notes/Views/BallDetailView.swift");
  });

  it("makes UIKit view controllers screens by the base-class chain — several in one file — with what each opens", async () => {
    const s = await loadReportSummary(out);
    const uikit = s.screens.filter((x) => x.filePath === "Notes/Legacy/ExportViewController.swift").map((x) => `${x.name} → ${x.navigatesTo.join(", ")}`).sort();
    expect(uikit).toEqual([
      "ExportDoneViewController → ",
      "ExportViewController → ExportDoneViewController, FormatPickerViewController",
      "FormatPickerViewController → ",
    ]);
  });

  it("reads SwiftData models — stored fields only — and where views read and write them", async () => {
    const s = await loadReportSummary(out);
    const fields = (s.entityGraph?.nodes ?? []).find((n) => n.name === "Ball")?.columns?.map((f) => f.name);
    expect(fields).toEqual(["name", "createdAt", "notes"]);
    expect((s.entityGraph?.edges ?? []).filter((e) => e.orm !== "coredata").length).toBe(1);
    const edges = (s.dataAccessGraph?.edges ?? []).map((e) => `${e.source} -> ${e.target}`);
    expect(edges).toContain("file::Notes/Views/BallListView.swift -> entity::Ball::Ball");
    expect(edges.some((e) => e.startsWith("file::Notes/Views/AddBallView.swift -> ") && e.includes("Ball"))).toBe(true);
  });

  it("reads a Core Data model — stored attributes, relationships with their inverse — and where code fetches and inserts", async () => {
    const s = await loadReportSummary(out);
    const node = (name: string) => (s.entityGraph?.nodes ?? []).find((n) => n.name === name);
    expect(node("ArchivedNote")).toMatchObject({ orm: "coredata", filePath: "Notes/Legacy/Archive.xcdatamodeld/Archive.xcdatamodel/contents" });
    expect(node("ArchivedNote")?.columns?.map((c) => `${c.name}:${c.type}`)).toEqual(["archivedAt:Date?", "title:String"]);
    expect(node("Folder")?.columns?.map((c) => c.name)).toEqual(["name"]);
    const edges = (s.entityGraph?.edges ?? []).filter((e) => e.orm === "coredata");
    expect(edges.map((e) => {
      const [from, to] = [node("Folder")!.id === e.source ? "Folder" : "ArchivedNote", node("Folder")!.id === e.target ? "Folder" : "ArchivedNote"];
      return `${from} ${e.sourceCardinality} — ${e.targetCardinality} ${to}`;
    })).toEqual([expect.stringMatching(/^(ArchivedNote many — one Folder|Folder one — many ArchivedNote)$/)]);
    const access = (s.dataAccessGraph?.edges ?? []).map((e) => `${e.source} -> ${e.target}`).filter((e) => e.includes("ArchiveStore"));
    expect(access.some((e) => e.includes("ArchivedNote"))).toBe(true);
    expect(access.some((e) => e.includes("Folder"))).toBe(true);
  });

  it("follows storyboard segues — through a navigation controller — and segues and storyboard ids named in code", async () => {
    const s = await loadReportSummary(out);
    const archive = s.screens.filter((x) => x.filePath === "Notes/Legacy/ArchiveViewControllers.swift").map((x) => `${x.name} → ${[...x.navigatesTo].sort().join(", ")}`).sort();
    expect(archive).toEqual([
      "ArchiveDetailViewController → ",
      "ArchiveFilterViewController → ",
      "ArchiveInfoViewController → ",
      "ArchiveListViewController → ArchiveDetailViewController, ArchiveFilterViewController, ArchiveInfoViewController",
    ]);
    expect(s.routeMap.some((r) => r.path.startsWith("@") || r.path.includes("showExport"))).toBe(false);
  });
});
