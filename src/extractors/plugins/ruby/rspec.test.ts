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
    // A call through it is a call on the constant, at the column it is written.
    expect(spec.calls.find((c) => c.name === "Club.leader_threshold")).toMatchObject({ line: 18, column: "      expect(".length });
    expect(extractTypeReferences(a, "ruby").filter((r) => r.sourceSymbol === "Club")).toMatchObject([{ typeName: "Club", sourceLine: 3 }]);
  });

  it("reads an enqueue of the described job however it is written, and member calls on a typed let, per block", () => {
    const a = analyze(`
RSpec.describe League::CloseWindowJob do
  let(:service) { League::TransferService.new }

  it "enqueues later" do
    described_class.set(wait: 5.minutes).perform_later(league)
  end

  it "enqueues in bulk" do
    described_class.perform_bulk([[1], [2]])
  end

  describe "the service" do
    it "settles" do
      service.settle
    end
    it { expect(service.total).to eq(3) }
  end

  def enqueue_now
    described_class.perform_now(service.league)
  end
end
`, "spec/jobs/league/close_window_job_spec.rb");
    const calls = (n: string) => a.functions.find((f) => f.name === n)!.calls.filter((c) => c.receiverType || /^service\./.test(c.name)).map((c) => [c.name, c.receiverType ?? null]);
    expect(calls("League:CloseWindowJob › enqueues later")).toEqual([["League::CloseWindowJob.perform", "League::CloseWindowJob"]]);
    expect(calls("League:CloseWindowJob › enqueues in bulk")).toEqual([["League::CloseWindowJob.perform", "League::CloseWindowJob"]]);
    expect(calls("League:CloseWindowJob › the service › settles")).toEqual([["service.settle", null]]);
    expect(calls("League:CloseWindowJob › the service › example at line 16")).toEqual([["service.total", null]]);
    // A helper `def` in a group types what the group does.
    const helper = a.functions.find((f) => f.name === "enqueue_now")!;
    expect(helper.localTypes).toEqual(expect.arrayContaining([{ name: "described_class", type: "League::CloseWindowJob" }, { name: "service", type: "League::TransferService" }]));
    expect(helper.calls.filter((c) => c.receiverType).map((c) => c.name)).toEqual(["League::CloseWindowJob.perform"]);
    // A group's typed passes never read its nested blocks' lines.
    expect(calls("League:CloseWindowJob › the service")).toEqual([]);
    expect(calls("League:CloseWindowJob")).toEqual([]);
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

describe("RSpec blocks over several lines", () => {
  it("gives a brace example its closing brace, and reads no example from a hash key", () => {
    const fns = analyze(`
RSpec.describe Club do
  let(:attributes) do
    {
      scenario: {
        name: League.default_name
      }
    }
  end

  it {
    expect(subject).to validate_presence_of(:name)
      .on(:create)
  }
end
`).functions;
    expect(fns.map((f) => `${f.name} ${f.line}-${f.endLine}: ${f.calls.map((c) => c.name).join(",")}`)).toEqual([
      "Club 1-14: let,League.default_name",
      "Club › example at line 10 10-13: expect,validate_presence_of",
    ]);
  });
});
