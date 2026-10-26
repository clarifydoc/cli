import { describe, it, expect } from "vitest";
import type { FileAnalysis } from "../../../types/analysis.js";
import { rubyAutoloadedFiles, rubyTypeNamedByReceiver, underscoreConstant } from "./autoload.js";

const FILES = [
  "app/models/club.rb",
  "app/models/concerns/promotable.rb",
  "app/services/league/match_report.rb",
  "enterprise/app/models/league/table.rb",
  "lib/tasks/club.rb",
  "lib/scoring/goal_counter.rb",
];
const endingWith = (suffix: string) => FILES.filter((f) => f === suffix || f.endsWith(`/${suffix}`));

const analysis = (calls: string[], classes: Array<{ name: string; extends?: string; implements?: string[] }>): FileAnalysis =>
  ({
    filePath: "app/controllers/league/tables_controller.rb",
    language: "ruby",
    imports: [],
    functions: [{ name: "show", calls: calls.map((name) => ({ name, line: 1 })) }],
    classes,
  }) as unknown as FileAnalysis;

describe("Ruby autoloading (Zeitwerk)", () => {
  it("spells a constant as its file", () => {
    expect(underscoreConstant("League::MatchReport")).toBe("league/match_report");
    expect(underscoreConstant("HTMLParser")).toBe("html_parser");
  });

  it("reads the constants a file names as the files under an autoload root", () => {
    const files = rubyAutoloadedFiles(
      analysis(["Club.find", "MatchReport.new", "Scoring::GoalCounter.count", "Table.all"], [{ name: "League::TablesController", extends: "ApplicationController", implements: ["Promotable"] }]),
      endingWith,
    );
    expect(files.sort()).toEqual([
      "app/models/club.rb",
      "app/models/concerns/promotable.rb",
      "app/services/league/match_report.rb",
      "enterprise/app/models/league/table.rb",
      "lib/scoring/goal_counter.rb",
    ]);
  });

  it("reads a local's name as the class it is named for", () => {
    expect(rubyTypeNamedByReceiver("match_report")).toBe("MatchReport");
    expect(rubyTypeNamedByReceiver("@club")).toBe("Club");
    expect(rubyTypeNamedByReceiver("Club")).toBeNull();
  });
});
