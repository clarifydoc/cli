import { describe, it, expect } from "vitest";
import { dartModuleBindings } from "./module-bindings.js";

describe("dart top-level variables", () => {
  it("reads a declared or constructed type, never a call's result, a function, a member or a keyword", () => {
    const lines = [
      "import 'club.dart';",
      "",
      "final SeasonTicket topTicket = SeasonTicket();",
      "late League league;",
      "const _table = League<Club>();",
      "final builtTicket = new SeasonTicket();",
      "final loaded = SeasonTicket.load();",
      "typedef Json = Map<String, dynamic>;",
      "Future<void> main() async {",
      "  final Club local = Club();",
      "}",
      "/*",
      "final Club commented = Club();",
      "*/",
      "class Desk {",
      "  final Club club = Club();",
      "}",
    ];
    expect(dartModuleBindings(lines)).toEqual([
      { name: "topTicket", type: "SeasonTicket", line: 3, exported: true },
      { name: "league", type: "League", line: 4, exported: true },
      { name: "_table", type: "League", line: 5, exported: false },
      { name: "builtTicket", type: "SeasonTicket", line: 6, exported: true },
    ]);
  });

  it("reads a top-level getter's declared return type, or the type its arrow body constructs", () => {
    const lines = [
      "GarageGateway? _garageGateway;",
      "GarageGateway get garageGateway {",
      "  _garageGateway ??= GarageGateway();",
      "  return _garageGateway!;",
      "}",
      "PitGateway get pitGateway => ServiceLocator.instance.pitGateway;",
      "Map<String, Club> get clubsByName =>",
      "    {};",
      "get workshop => Workshop(bays: 4);",
      "get loaded => Workshop.load();",
      "void get nothing => null;",
      "class Garage {",
      "  Bay get bay => Bay();",
      "}",
    ];
    expect(dartModuleBindings(lines)).toEqual([
      { name: "_garageGateway", type: "GarageGateway?", line: 1, exported: false },
      { name: "garageGateway", type: "GarageGateway", line: 2, exported: true },
      { name: "pitGateway", type: "PitGateway", line: 6, exported: true },
      { name: "clubsByName", type: "Map<String, Club>", line: 7, exported: true },
      { name: "workshop", type: "Workshop", line: 9, exported: true },
    ]);
  });
});
