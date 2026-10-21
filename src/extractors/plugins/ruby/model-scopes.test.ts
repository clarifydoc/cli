import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";

const analyze = (src: string) => {
  const lines = src.split("\n");
  const classes = rubySpec.extractClasses!(lines, []);
  const sources = (rubySpec.extractDataSources!(lines, classes) ?? []).filter((d) => d.kind === "database");
  return { classes, sources };
};

describe("Rails model scopes and queries on the model itself", () => {
  const model = `
class Club < ApplicationRecord
  has_many :players

  scope :active, -> { where(active: true) }
  scope :visible_to, lambda { |league|
    joins(:league)
      .where(league_id: league.id)
  }

  def self.search(term)
    where("name ILIKE ?", "%#{term}%").order(:name)
  end

  def relegate!
    update!(division: division + 1)
    save!
  end
end`;

  it("records each scope as a class method of the model, spanning its lambda", () => {
    const club = analyze(model).classes.find((c) => c.name === "Club")!;
    const scopes = club.methods.filter((m) => m.decorators.includes("scope")).map((m) => [m.name, m.line, m.endLine]);
    expect(scopes).toEqual([["active", 5, 5], ["visible_to", 6, 9]]);
  });

  it("reads a bare query and a bare write as the model's own rows", () => {
    const rows = analyze(model).sources.map((d) => [d.name, d.entity, d.access, d.line]);
    expect(rows).toEqual([
      ["Club.where", "Club", "read", 5],
      ["Club.joins", "Club", "read", 7],
      ["Club.where", "Club", "read", 12],
      ["Club.update!", "Club", "write", 16],
      ["Club.save!", "Club", "write", 17],
    ]);
  });

  it("leaves a class that is no model alone", () => {
    const { classes, sources } = analyze(`
class TableBuilder
  scope :x, -> { where(a: 1) }
  def build
    find(1)
  end
end`);
    expect(classes[0]!.methods.map((m) => m.name)).toEqual(["build"]);
    expect(sources).toEqual([]);
  });
});
