import { describe, it, expect } from "vitest";
import { rubyModuleBindings } from "./module-bindings.js";

describe("ruby top-level constants", () => {
  it("reads a constant constructed at column 0, never a chain, a class maker, an indented or a rebound one", () => {
    const lines = [
      'require_relative "club_service"',
      "SERVICE = ClubService.new",
      "DEPOT = ::Garage::Depot.new(1, :main) # the depot",
      "PIT = PitCrew.new crew, 3",
      "RUN = ClubService.new.run",
      "POINT = Struct.new(:x, :y)",
      "FACTORY = ClubService.build",
      "module League",
      "  INNER = ClubService.new",
      "end",
      "MIXED = ClubService.new",
      "MIXED = Garage.new",
      "LATER =",
      "  ClubService.new",
      "REBOUND = ClubService.new",
      "REBOUND ||= build_service",
    ];
    expect(rubyModuleBindings(lines).map((b) => `${b.name}:${b.type}`)).toEqual(["SERVICE:ClubService", "DEPOT:::Garage::Depot", "PIT:PitCrew"]);
  });
});
