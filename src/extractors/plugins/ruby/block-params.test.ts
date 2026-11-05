import { describe, it, expect, beforeAll } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis, SymbolLink } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "ruby"), projectId: "root" });

const TEAM = `class Team < ApplicationRecord
  has_many :players
  has_one :coach
end
`;
const PLAYER = `class Player < ApplicationRecord
  belongs_to :team
  def injure!
    1
  end
end
`;
const COACH = `class Coach < ApplicationRecord
  def sack!
    1
  end
end
`;
// Namesakes: another class answering the same names, which no receiver below is typed as.
const DECOY = `class Decoy
  def injure!
    2
  end

  def refresh(x)
    2
  end
end
`;

const targets = (links: SymbolLink[], file: string, callName: string) =>
  [...new Set(links.filter((l) => l.sourceFile === file && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`))];

describe("Ruby: block parameters", () => {
  const SVC = `class Svc
  def roster(id)
    team = Team.find(id)
    team.players.each { |p| p.injure! }
    team.coach.sack!
  end

  def sweep(rows)
    rows.each do |row|
      row.refresh(1)
    end
  end

  def reschedule(rows)
    rows.each do |fixture|
      fixture.postpone!
    end
  end
end
`;
  const FIXTURE = `class Fixture
  def postpone!
    1
  end
end
`;
  const links = buildSymbolLinks([
    read(TEAM, "app/models/team.rb"),
    read(PLAYER, "app/models/player.rb"),
    read(COACH, "app/models/coach.rb"),
    read(DECOY, "app/services/decoy.rb"),
    read(FIXTURE, "app/models/fixture.rb"),
    read(SVC, "app/services/svc.rb"),
  ]);

  it("types a block parameter by the association it iterates", () => {
    expect(targets(links, "app/services/svc.rb", "p.injure!")).toEqual(["app/models/player.rb::Player.injure!"]);
  });

  it("keeps single-association chains typed (has_one, belongs_to)", () => {
    expect(targets(links, "app/services/svc.rb", "team.coach.sack!")).toEqual(["app/models/coach.rb::Coach.sack!"]);
  });

  it("never guesses the only definition of a name for a parameter of untyped rows", () => {
    expect(targets(links, "app/services/svc.rb", "row.refresh")).toEqual([]);
  });

  it("still takes it for a parameter named exactly for the target's class", () => {
    expect(targets(links, "app/services/svc.rb", "fixture.postpone!")).toEqual(["app/models/fixture.rb::Fixture.postpone!"]);
  });
});

describe("Ruby: anonymous subclasses in a spec", () => {
  const BASE = `class Club
  def close
    1
  end

  def open
    1
  end
end
`;
  const SPEC = `RSpec.describe Club do
  it "closes through an anonymous subclass" do
    klass = Class.new(Club)
    klass.new.close
  end

  it "keeps a built instance typed" do
    plain = Class.new(Club)
    inst = plain.new
    inst.close
  end

  it "types no instance of a subclass with overrides" do
    klass = Class.new(Club) do
      def open
        2
      end
    end
    other = klass.new
    other.open
    klass.new.open
    klass.new.close
  end
end
`;
  const links = buildSymbolLinks([read(BASE, "app/models/club.rb"), read(SPEC, "spec/models/club_spec.rb")]);

  it("resolves calls on its instances through the base class", () => {
    expect(targets(links, "spec/models/club_spec.rb", "new.close")).toEqual(["app/models/club.rb::Club.close"]);
    expect(targets(links, "spec/models/club_spec.rb", "inst.close")).toEqual(["app/models/club.rb::Club.close"]);
  });

  it("leaves a method the block overrides alone", () => {
    expect(targets(links, "spec/models/club_spec.rb", "other.open")).toEqual([]);
    expect(targets(links, "spec/models/club_spec.rb", "new.open")).toEqual([]);
  });
});

describe("Ruby: jobs in a spec", () => {
  const JOB = `class ScoreJob < ApplicationJob
  def perform(match)
    match
  end
end
`;
  const SPEC = `RSpec.describe ScoreJob do
  it "runs now" do
    described_class.perform_now(1)
  end

  it "runs later" do
    described_class.set(wait: 1).perform_later(1)
  end
end
`;
  const links = buildSymbolLinks([read(JOB, "app/jobs/score_job.rb"), read(SPEC, "spec/jobs/score_job_spec.rb")]);

  it("links described_class.perform_now and .set(…).perform_later to perform, once per example", () => {
    const rows = links.filter((l) => l.sourceFile === "spec/jobs/score_job_spec.rb" && l.relation === "calls");
    expect(rows.map((l) => `${l.sourceSymbol}:${l.sourceLine}`).sort()).toEqual([
      "ScoreJob › runs later:7",
      "ScoreJob › runs now:3",
    ]);
    expect(new Set(rows.map((l) => l.targetSymbol))).toEqual(new Set(["ScoreJob.perform"]));
  });
});
