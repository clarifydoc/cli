import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { extractTypeReferences } from "../../../core/type-reference-extractor.js";

const analyze = (src: string, filePath = "spec/models/club_spec.rb") => extractWithRegex(src.replace(/^\n/, ""), filePath, "ruby");

describe("RSpec blocks as functions", () => {
  const src = `
require "rails_helper"

RSpec.describe Club, type: :model do
  let(:club) { Club.new(points: 60) }
  before(:each) do
    League.reset!
  end

  describe ".rank" do
    it "orders by points" do
      clubs = [Club.new(points: 3), Club.new(points: 9)]
      expect(Club.rank(clubs).first.points).to eq(9)
    end
  end

  context "leader" do
    specify "a club over fifty is a leader" do
      expect(described_class.leader_threshold).to eq(50)
    end
    it { expect(Club.top).to be_present }
  end
end
`;

  it("names groups, examples and hooks by their title path, with the calls of their own lines", () => {
    const fns = analyze(src).functions;
    expect(fns.map((f) => f.name)).toEqual([
      "Club",
      "Club › before",
      "Club › .rank",
      "Club › .rank › orders by points",
      "Club › leader",
      "Club › leader › a club over fifty is a leader",
      "Club › leader › example at line 20",
    ]);
    const calls = (n: string) => fns.find((f) => f.name === n)!.calls.map((c) => c.name);
    expect(calls("Club › .rank › orders by points")).toContain("Club.rank");
    expect(calls("Club › before")).toContain("League.reset!");
    expect(calls("Club › leader › example at line 20")).toContain("Club.top");
    // A group keeps its `let` blocks, never its examples' calls.
    expect(calls("Club")).not.toContain("Club.rank");
    expect(calls("Club › .rank")).toEqual([]);
    const example = fns.find((f) => f.name === "Club › .rank › orders by points")!;
    expect(example.testCase).toEqual({ title: "orders by points", path: ["Club", ".rank"], kind: "case" });
    expect(example.line).toBe(10);
    expect(fns[0]!.testCase).toEqual({ title: "Club", path: [], kind: "suite", subject: "Club" });
  });

  it("types described_class as the described constant, and records the subject as a type reference", () => {
    const a = analyze(src);
    const spec = a.functions.find((f) => f.name === "Club › leader › a club over fifty is a leader")!;
    expect(spec.localTypes).toContainEqual({ name: "described_class", type: "Club" });
    expect(extractTypeReferences(a, "ruby").filter((r) => r.sourceSymbol === "Club")).toMatchObject([{ typeName: "Club", sourceLine: 3 }]);
  });

  it("leaves a file with no RSpec group alone", () => {
    const a = analyze(`
class Garage
  def park(car)
    it "x" do
      car.stop
    end
  end
end
`, "app/models/garage.rb");
    expect(a.functions.filter((f) => f.testCase)).toEqual([]);
  });
});
