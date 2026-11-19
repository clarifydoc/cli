import { describe, it, expect } from "vitest";
import { joinConfigFiles } from "./config-files.js";
import type { FileAnalysis, SubProject } from "../types/analysis.js";

const file = (filePath: string, extra: Partial<FileAnalysis> = {}, projectId = "app"): FileAnalysis =>
  ({ filePath, language: "java", projectId, functions: [], classes: [], imports: [], ...extra }) as unknown as FileAnalysis;
const subProjects = [{ id: "app", root: "app" }, { id: "billing", root: "billing" }] as unknown as SubProject[];
const run = (analyses: FileAnalysis[], disk: string[] = []) => joinConfigFiles(analyses, subProjects, () => true, (f) => f.includes("/test/"), async (f) => disk.includes(f));

describe("config file reads", () => {
  const reader = file("app/src/Club.java", {
    filePathReads: [
      { parts: ["config/league.json"], line: 3 },
      { parts: ["config", "cup.json"], line: 4 },
      { parts: ["league.json"], line: 5, anchor: "file" },
      { parts: ["/etc/league.json"], line: 6 },
      { parts: ["../../billing/invoice.json"], line: 7 },
      { parts: ["src/Garage.java"], line: 8 },
    ],
  });

  it("resolves beside the reader, then at the sub-project root, then at the analysis root", async () => {
    const rows = await run([reader, file("app/config/league.json")], ["config/cup.json", "app/src/league.json"]);
    expect(rows.map((r) => [r.file, r.consumers.map((c) => c.line)])).toEqual([
      ["app/config/league.json", [3]],
      ["app/src/league.json", [5]],
      ["config/cup.json", [4]],
    ]);
  });

  it("never joins by file name alone, nor an absolute path, nor code", async () => {
    const rows = await run([reader, file("other/deep/league.json"), file("app/src/Garage.java", { classes: [{ name: "Garage" }] as never })]);
    expect(rows).toEqual([]);
  });

  it("keeps a namesake of another sub-project apart and skips test readers", async () => {
    const rows = await run([file("app/src/test/ClubTest.java", { filePathReads: [{ parts: ["league.json"], line: 1 }] }), file("app/league.json"), reader, file("billing/config/league.json", {}, "billing")]);
    expect(rows).toEqual([]);
  });
});
