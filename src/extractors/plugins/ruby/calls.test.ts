import { describe, it, expect } from "vitest";
import { extractCallsFromBody } from "../shared/regex-base.js";
import { rubySpec } from "./index.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

const calls = (src: string) => {
  const lines = src.split("\n");
  return extractCallsFromBody(lines, 0, lines.length, rubySpec.lineCommentPrefixes, rubySpec.callPatterns).map((c) => c.name);
};

describe("ruby paren-less calls", () => {
  it("captures a command call on a local, safe-navigated or not, and never an attribute read before a keyword", () => {
    expect(calls("    club.promote 1")).toContain("club.promote");
    expect(calls("    club&.relegate :season")).toContain("club.relegate");
    expect(calls("    club.rank squad")).toContain("club.rank");
    expect(calls("    puts club.name if squad")).not.toContain("club.name");
    expect(calls("    x = club.size unless squad")).not.toContain("club.size");
    expect(calls("    total = club.points + 1")).not.toContain("club.points");
  });

  it("captures a constant receiver with no parentheses", () => {
    expect(calls("    Player.all.map(&:to_h)")).toContain("Player.all");
  });

  it("captures predicate and bang methods", () => {
    expect(calls("    raise 'nope' unless player.valid?")).toContain("player.valid?");
    expect(calls("    car.save!")).toContain("car.save!");
  });

  it("keeps a predicate or bang method's suffix on a constant receiver — no truncated twin", () => {
    expect(calls("      HolidaysHelper.is_holiday?(date)")).toEqual(["HolidaysHelper.is_holiday?"]);
    expect(calls("      Pools.validate!(params[:id])")).toEqual(["Pools.validate!"]);
    expect(calls("      return if Car.count!= 0")).toEqual(["Car.count"]);
  });

  it("captures a bare `receiver.method` statement", () => {
    expect(calls("    player.destroy")).toContain("player.destroy");
  });

  it("leaves an attribute read inside an expression alone", () => {
    // `car.total` in expression position is indistinguishable from a
    // zero-arity call; taking it would link to every project method named
    // `total`.
    expect(calls("    total = car.total + shipping.amount")).toEqual([]);
  });

  it("does not take stdlib or framework constants as project calls", () => {
    expect(calls("    Rails.logger.info Time.now.to_s")).toEqual([]);
  });

  it("names a call through a path of readers by every name, never by the last two", () => {
    // Read as `league.relegate`, the linker would type the receiver by the caller's own `league`.
    expect(calls("    club.league.relegate(season)")).toEqual(["club.league.relegate"]);
    expect(calls("    @club.league.relegate(season)")).toEqual(["club.league.relegate"]);
    expect(calls("    self.club.league.relegate(season)")).toEqual(["self.club.league.relegate"]);
    expect(calls("    club&.league&.relegate!(season)")).toEqual(["club.league.relegate!"]);
    expect(calls("    matched = u.name.downcase.include?(query)")).toEqual(["u.name.downcase.include?"]);
    // One reader on the caller's own instance stays the reader pattern's.
    expect(calls("    self.repo.find(id)")).toEqual(["repo.find"]);
    expect(calls("    repo.find(id)")).toEqual(["repo.find"]);
  });

  it("names a paren-less predicate or command call through a path by every name, and no reader along it", () => {
    expect(calls("    return if club.league.relegated?")).toEqual(["club.league.relegated?"]);
    expect(calls("    @club&.league&.reset_table!")).toEqual(["club.league.reset_table!"]);
    expect(calls("    club.league.promote 1")).toEqual(["club.league.promote"]);
    expect(calls("    @club.league.promote :top")).toEqual(["club.league.promote"]);
    expect(calls("    self.club.league.promote places")).toEqual(["self.club.league.promote"]);
    // One reader on the caller's own instance is named as the reader, as `self.club.relegate(` is.
    expect(calls("    self.club.relegated?")).toEqual(["club.relegated?"]);
    expect(calls("    self.club.promote 1")).toEqual(["club.promote"]);
    expect(calls("    raise Closed unless self.class.open?")).toEqual(["self.class.open?"]);
    // A reader along the path, or at its end, is no call: no argument follows it.
    expect(calls("    total = club.league.points + 1")).toEqual([]);
    expect(calls("    puts club.league.name if squad")).toEqual([]);
    expect(calls("    return 0 if club.league.size!= 0")).toEqual([]);
    expect(calls("    club.league.clubs.each do |c|")).toEqual([]);
  });
});

describe("ruby nested classes", () => {
  it("gives a method to its innermost class or module only", () => {
    const src = `module Staff
  def self.helper
  end
  class PlannerController < ApplicationController
    def index
    end
  end
end`;
    const classes = extractClassesWithSpec(src.split("\n"), rubySpec);
    expect(classes.map((c) => [c.name, c.methods.map((m) => m.name)])).toEqual([
      ["Staff", ["helper"]],
      ["PlannerController", ["index"]],
    ]);
  });
});

describe("ruby calls on a constructed local", () => {
  it("records a paren-less member call on a local the method built", () => {
    const lines = [
      "class PlayersController",
      "  def create",
      "    builder = PlayerBuilder.new(",
      "      name: params[:name]",
      "    )",
      "    @player = builder.perform",
      "    label = builder.name_label",
      "  end",
      "end",
    ];
    const cls = rubySpec.extractClasses!(lines, [])[0]!;
    const names = cls.methods[0]!.calls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["builder.perform", "builder.name_label"]));
  });
});

describe("ruby bare calls of the class's own methods", () => {
  it("records a bare own-method name as a call, not a local, symbol, key or member", () => {
    const lines = [
      "class SquadBuilder",
      "  def perform",
      "    raise Full unless room?",
      "    @player = find_or_sign_player",
      "    create_contract",
      "    contract = 1",
      "    log(contract, kind: :create_contract, note: 'room?')",
      "    other.create_contract",
      "  end",
      "  def room?; true; end",
      "  def find_or_sign_player; end",
      "  def create_contract; end",
      "end",
    ];
    const cls = rubySpec.extractClasses!(lines, [])[0]!;
    const perform = cls.methods.find((m) => m.name === "perform")!;
    const own = perform.calls.filter((c) => !c.name.includes(".") && !["log", "other"].includes(c.name)).map((c) => `${c.name}@${c.line}`);
    expect(own.sort()).toEqual(["create_contract@5", "find_or_sign_player@4", "room?@3"]);
  });
});

describe("ruby calls whose receiver the name spells only in part", () => {
  const cut = (src: string) => {
    const lines = src.split("\n");
    return extractCallsFromBody(lines, 0, lines.length, rubySpec.lineCommentPrefixes, rubySpec.callPatterns)
      .filter((c) => c.receiverCut).map((c) => c.name);
  };

  it("marks a name read past something no name spells, and never a path named from its head", () => {
    expect(cut("    { club: 1 }.league.relegate(1)")).toEqual(["league.relegate"]);
    expect(cut("    club.league.relegate(1)\n    @club.league.relegate(2)")).toEqual([]);
  });

  it("marks the one record of a name when a later occurrence is cut", () => {
    expect(cut("    league.relegate(1)\n    { club: 1 }.league.relegate(2)")).toEqual(["league.relegate"]);
  });
});
