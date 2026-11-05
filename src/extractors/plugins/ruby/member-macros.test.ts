import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import { rubySpec } from "./index.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby"]);
});

const methodsOf = (src: string, cls: string) =>
  rubySpec.extractClasses!(src.split("\n"), []).find((c) => c.name === cls)!.methods.filter((m) => m.synthetic);

describe("Ruby: members a macro declares", () => {
  const club = `class Club
  attr_reader :name, :rank
  attr_accessor :stadium
  cattr_accessor :registry
  delegate :stadium_name, :capacity, to: :stadium
  delegate :serial, prefix: :engine, to: :car, allow_nil: true
  def_delegator :@matches, :first, :next_match
  def_delegators :@matches, :last, :size
  alias_method :title, :name
  alias short_name name
  define_method(:kick_off) { 1 }
  def name
    "own"
  end
end`;

  it("records readers, writers, delegates, aliases and defined methods as synthetic members", () => {
    const m = methodsOf(club, "Club");
    const names = m.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["rank", "stadium", "stadium=", "registry", "registry=", "stadium_name", "capacity", "engine_serial", "next_match", "last", "size", "title", "short_name", "kick_off"]));
    // The class writes `name` itself: no synthetic reader replaces it.
    expect(names).not.toContain("name");
    expect(m.find((x) => x.name === "registry" && x.classLevel)).toBeTruthy();
  });

  it("makes a delegating member call its target, and an alias call the original", () => {
    const m = methodsOf(club, "Club");
    expect(m.find((x) => x.name === "engine_serial")!.calls.map((c) => c.name)).toEqual(["car.serial", "car"]);
    expect(m.find((x) => x.name === "next_match")!.calls.map((c) => c.name)).toEqual(["matches.first"]);
    expect(m.find((x) => x.name === "title")!.calls.map((c) => c.name)).toEqual(["name"]);
  });

  it("does not read a macro inside a method body", () => {
    const m = methodsOf("class Club\n  def setup\n    attr_reader :hidden\n  end\nend", "Club");
    expect(m).toEqual([]);
  });
});

describe("Ruby: association readers chain onto the associated model", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "app/models/club.rb": `class Club < ApplicationRecord
  has_many :players
  has_one :stadium
  belongs_to :league
  delegate :stadium_name, to: :stadium
  def venue
    stadium_name
  end
  def roster
    players.first.train
  end
  def division
    league.promote
  end
end
`,
    "app/models/player.rb": `class Player < ApplicationRecord
  belongs_to :club
  def train
    1
  end
end
`,
    "app/models/stadium.rb": `class Stadium < ApplicationRecord
  def stadium_name
    "ground"
  end
end
`,
    "app/models/league.rb": `class League < ApplicationRecord
  def promote
    1
  end
end
`,
    "app/services/scout.rb": `class Scout
  def run
    club = Club.find(1)
    club.stadium.stadium_name
    club.players.first.train
    club.venue
  end
end
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-macros-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (callName: string, from: string) =>
    summary.symbolLinks.filter((l) => l.callName === callName && l.sourceSymbol === from).map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("follows a chain off a typed local through the readers to the method", () => {
    expect(target("club.stadium.stadium_name", "Scout.run")).toEqual(["app/models/stadium.rb::Stadium.stadium_name"]);
    expect(target("club.players.first.train", "Scout.run")).toEqual(["app/models/player.rb::Player.train"]);
    expect(target("club.venue", "Scout.run")).toEqual(["app/models/club.rb::Club.venue"]);
  });

  it("follows a chain off an association the class itself reads", () => {
    expect(target("players.first.train", "Club.roster")).toEqual(["app/models/player.rb::Player.train"]);
    expect(target("league.promote", "Club.division")).toEqual(["app/models/league.rb::League.promote"]);
  });

  it("reaches a delegated member, and through its target the model's method", () => {
    expect(target("stadium_name", "Club.venue")).toEqual(["app/models/club.rb::Club.stadium_name"]);
    expect(target("stadium.stadium_name", "Club.stadium_name")).toEqual(["app/models/stadium.rb::Stadium.stadium_name"]);
  });
});
