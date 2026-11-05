import { describe, it, expect, beforeAll } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis, SymbolLink } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "ruby"), projectId: "root" });

const RANKING = `module Ranking
  extend ActiveSupport::Concern

  class_methods do
    def by_rank(direction = :desc)
      order(rank: direction)
    end
  end
end
`;

const CLUB = `class Club < ApplicationRecord
  include Ranking

  scope :active, -> { where(active: true) }

  def self.search(query)
    where(name: query)
  end

  def tally
    1
  end

  def by_rank
    0
  end
end
`;

const SERVICE = `class TableService
  def call
    Club.where(league_id: 1).by_rank
    Club.active.order(:name).by_rank
    Club.active.by_rank
    Club.where(league_id: 2).search('rovers')
    Club.active.first.tally
    Club.where(league_id: 3).first.by_rank
  end
end
`;

const targetsOf = (links: SymbolLink[], callName: string) =>
  [...new Set(links.filter((l) => l.sourceFile === "app/services/table_service.rb" && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`))];

describe("Ruby: a query of a model answers the model's class methods", () => {
  const link = () =>
    buildSymbolLinks([
      read(RANKING, "app/models/concerns/ranking.rb"),
      read(CLUB, "app/models/club.rb"),
      read(SERVICE, "app/services/table_service.rb"),
    ]);

  it("calls a concern's class method, a scope's and a class method on the relation a query or a scope returns", () => {
    const links = link();
    expect(targetsOf(links, "Club.where().by_rank")).toEqual(["app/models/concerns/ranking.rb::ClassMethods.by_rank"]);
    expect(targetsOf(links, "Club.active().order().by_rank")).toEqual(["app/models/concerns/ranking.rb::ClassMethods.by_rank"]);
    expect(targetsOf(links, "Club.active().by_rank")).toEqual(["app/models/concerns/ranking.rb::ClassMethods.by_rank"]);
    expect(targetsOf(links, "Club.where().search")).toEqual(["app/models/club.rb::Club.search"]);
  });

  it("keeps a record's instance methods on what a finder returns", () => {
    const links = link();
    expect(targetsOf(links, "Club.active().first().tally")).toEqual(["app/models/club.rb::Club.tally"]);
    expect(targetsOf(links, "Club.where().first().by_rank")).toEqual(["app/models/club.rb::Club.by_rank"]);
  });
});
