import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";

const analyze = (src: string) => {
  const lines = src.split("\n");
  const classes = rubySpec.extractClasses!(lines, []);
  const sources = rubySpec.extractDataSources!(lines, classes);
  return { classes, sources };
};

describe("ActiveJob / Sidekiq enqueues and mailer deliveries", () => {
  it("calls the job's perform and publishes on the queue named after it", () => {
    const { classes, sources } = analyze(`
class Api::V1::MatchesController < ApplicationController
  def close
    ::ScoreJob.perform_later(@match)
    Leagues::TableJob.set(wait: 5.minutes).perform_later(league_id: 3)
    StandingsWorker.perform_async(@match.id)
  end
end
`);
    const calls = classes[0]!.methods[0]!.calls.filter((c) => c.receiverType);
    expect(calls.map((c) => [c.name, c.receiverType])).toEqual([
      ["ScoreJob.perform", "ScoreJob"],
      ["Leagues::TableJob.perform", "Leagues::TableJob"],
      ["StandingsWorker.perform", "StandingsWorker"],
    ]);
    expect(sources.filter((s) => s.kind === "queue-publish").map((s) => [s.name, s.target])).toEqual([
      ["ActiveJob: perform_later", "ScoreJob"],
      ["ActiveJob: perform_later", "TableJob"],
      ["ActiveJob: perform_async", "StandingsWorker"],
    ]);
  });

  it("makes a job class's perform the consumer of its queue", () => {
    const { sources } = analyze(`
class Leagues::TableJob < ApplicationJob
  queue_as :low

  def perform(league_id:)
    League.find(league_id).recompute!
  end
end

class StandingsWorker
  include Sidekiq::Worker

  def perform(id)
  end
end

class TableBuilder
  def perform
  end
end
`);
    expect(sources.filter((s) => s.kind === "queue-consume").map((s) => [s.target, s.line])).toEqual([
      ["TableJob", 5],
      ["StandingsWorker", 13],
    ]);
  });

  it("calls the mailer method a delivery sends", () => {
    const { classes } = analyze(`
class ClubsController
  def create
    ClubMailer.with(club: @club, owner: find_owner(id)).welcome.deliver_later
    Staff::RefereeMailer.assignment(@match).deliver_now
  end
end
`);
    const calls = classes[0]!.methods[0]!.calls.filter((c) => c.receiverType);
    expect(calls.map((c) => [c.name, c.receiverType]).sort()).toEqual([
      ["ClubMailer.welcome", "ClubMailer"],
      ["Staff::RefereeMailer.assignment", "Staff::RefereeMailer"],
    ]);
  });
});
