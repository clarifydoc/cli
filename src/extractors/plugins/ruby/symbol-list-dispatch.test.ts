import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const callsOf = (src: string, method: string): string[] => {
  const cls = extractWithRegex(src, "app/jobs/match_events_job.rb", "ruby").classes[0]!;
  return cls.methods.find((m) => m.name === method)!.calls.map((c) => c.name);
};

describe("ruby send() with a name from a constant symbol list", () => {
  const src = (gate: string) => `class MatchEventsJob < ApplicationJob
  SUPPORTED_EVENTS = [:goal_scored, :red_card, :streaker].freeze
  OTHER = %i[kickoff].freeze

  def perform(event)
    @event = event
    send(event_name)
  end

  def event_name
    @event_name ||= ${gate} ? @event[:event] : nil
  end

  def goal_scored; end
  def red_card; end
  def kickoff; end
end`;

  it("calls each listed method the class defines when the list gates the name", () => {
    const calls = callsOf(src("SUPPORTED_EVENTS.include?(@event[:event].to_sym)"), "perform");
    expect(calls).toContain("goal_scored");
    expect(calls).toContain("red_card");
    // Not defined by the class: never invented. A list nothing gates with is no evidence.
    expect(calls).not.toContain("streaker");
    expect(calls).not.toContain("kickoff");
  });

  it("calls nothing when no constant list gates the name", () => {
    const calls = callsOf(src("@event[:event].present?"), "perform");
    expect(calls).not.toContain("goal_scored");
    expect(calls).not.toContain("red_card");
  });
});
