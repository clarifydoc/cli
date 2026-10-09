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
    expect(calls("    User.all.map(&:to_h)")).toContain("User.all");
  });

  it("captures predicate and bang methods", () => {
    expect(calls("    raise 'nope' unless user.valid?")).toContain("user.valid?");
    expect(calls("    order.save!")).toContain("order.save!");
  });

  it("keeps a predicate or bang method's suffix on a constant receiver — no truncated twin", () => {
    expect(calls("      HolidaysHelper.is_holiday?(date)")).toEqual(["HolidaysHelper.is_holiday?"]);
    expect(calls("      Pools.validate!(params[:id])")).toEqual(["Pools.validate!"]);
    expect(calls("      return if Order.count!= 0")).toEqual(["Order.count"]);
  });

  it("captures a bare `receiver.method` statement", () => {
    expect(calls("    user.destroy")).toContain("user.destroy");
  });

  it("leaves an attribute read inside an expression alone", () => {
    // `order.total` in expression position is indistinguishable from a
    // zero-arity call; taking it would link to every project method named
    // `total`.
    expect(calls("    total = order.total + shipping.amount")).toEqual([]);
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
