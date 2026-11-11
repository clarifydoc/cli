import { describe, it, expect } from "vitest";
import { rubyModuleBindings } from "./module-bindings.js";

describe("ruby top-level constants", () => {
  it("reads a constant constructed at column 0 (or inside a module, qualified by it), never a chain, a class maker, an indented or a rebound one", () => {
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
    expect(rubyModuleBindings(lines).map((b) => `${b.name}:${b.type}`)).toEqual(["SERVICE:ClubService", "DEPOT:::Garage::Depot", "PIT:PitCrew", "League::INNER:ClubService"]);
  });

  it("qualifies a constant by every module around it, spans its body, and leaves a class's constants out", () => {
    const lines = [
      "module League",
      "  SERVICE = ClubService.new",
      "  module Cup",
      "    TROPHY = Trophy.new",
      "  end",
      "  class Club",
      "    OWN = ClubService.new",
      "  end",
      "  AFTER = Depot.new",
      "end",
      "module Shop; end",
      "LATE = Garage.new",
    ];
    const out = rubyModuleBindings(lines);
    expect(out.map((b) => b.name)).toEqual(["League::SERVICE", "League::Cup::TROPHY", "League::AFTER", "LATE"]);
    expect(out.map((b) => b.lexical && [b.lexical.name, b.lexical.line, b.lexical.endLine])).toEqual([
      ["SERVICE", 1, 10],
      ["TROPHY", 3, 5],
      ["AFTER", 1, 10],
      undefined,
    ]);
  });
});
