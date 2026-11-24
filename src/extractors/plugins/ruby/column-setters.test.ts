import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

/**
 * `club.status = x` on a model whose schema declares the column runs no method the source writes: it is a write of
 * that field. The receiver is typed as any call's is (a local from a finder, a call's result); a model without the
 * column, a class that is no model and an untyped receiver state nothing, and a real `def status=` stays a call.
 */
const FILES: Record<string, string> = {
  "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
  "app/models/club.rb": "class Club < ApplicationRecord\n  def name=(value)\n    super(value.strip)\n  end\nend\n",
  "app/models/rival.rb": "class Rival < ApplicationRecord\nend\n",
  "app/models/academy.rb": "class Academy < Club\nend\n",
  "app/models/mascot.rb": "class Mascot\n  attr_accessor :colour\nend\n",
  "app/services/repo.rb": "class Repo\n  def find(id)\n    Club.find_by(id: id)\n  end\nend\n",
  "db/schema.rb": `ActiveRecord::Schema.define(version: 2026_01_01_000000) do
  create_table "clubs", force: :cascade do |t|
    t.string "name"
    t.integer "status"
    t.integer "rating"
  end

  create_table "rivals", force: :cascade do |t|
    t.string "title"
  end
end
`,
  "app/services/board.rb": `class Board
  def promote(id)
    club = Club.find(id)
    club.status = 2
    club.rating += 1
    club.name = "x"
    club.nickname = "n"
  end

  def viaRepo(other)
    repo = Repo.new
    repo.find(1).status = 3
  end

  def viaSubclass(id)
    academy = Academy.find(id)
    academy.status = 4
  end

  def decoys(id)
    rival = Rival.find(id)
    rival.status = 1
    mascot = Mascot.new
    mascot.status = 1
    thing.status = 1
  end
end
`,
};

let summary: ProjectAnalysis;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cd-ruby-columns-"));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  summary = await loadReportSummary(join(dir, "out"));
}, 120_000);
afterAll(async () => rm(dir, { recursive: true, force: true }));

const writesBy = (fn: string): string[] => (summary.fieldWrites ?? []).filter((w) => w.function === fn).map((w) => `${w.class}.${w.member}@${w.line}`).sort();

describe("Ruby column setters", () => {
  it("records a write of a schema column on a typed local, a call's result and a subclass of the model", () => {
    expect(writesBy("Board.promote")).toEqual(expect.arrayContaining(["Club.status@4"]));
    expect(writesBy("Board.viaRepo")).toEqual(["Club.status@12"]);
    expect(writesBy("Board.viaSubclass")).toEqual(["Academy.status@17"]);
  });

  it("states nothing for a column the model lacks, a class that is no model, or an untyped receiver", () => {
    expect(writesBy("Board.promote").filter((w) => w.startsWith("Club.nickname"))).toEqual([]);
    expect(writesBy("Board.decoys")).toEqual([]);
  });

  it("leaves a column setter out of the links, and a real setter method a call", () => {
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceSymbol === "Board.promote").map((l) => l.callName);
    expect(links).toContain("club.name=");
    expect(links).not.toContain("club.status=");
  });
});
