import { describe, it, expect } from "vitest";
import { extractCallsFromBody } from "../shared/regex-base.js";
import { rubySpec } from "./index.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

const calls = (src: string) => {
  const lines = src.split("\n");
  return extractCallsFromBody(lines, 0, lines.length, rubySpec.lineCommentPrefixes, rubySpec.callPatterns).map((c) => c.name);
};

describe("ruby paren-less calls", () => {
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

  it("skips a receiver that is itself a call result", () => {
    expect(calls("    matched = u.name.downcase.include?(query)")).toEqual([]);
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
