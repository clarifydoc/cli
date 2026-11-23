import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * AngularJS 1 and Alpine front ends beside an Express backend: a click in a template reaches the handler of the
 * component the markup names (`ng-controller`, a `templateUrl` bound to a controller, `x-data`), through the injected
 * service (by name, array annotation or `$inject`) to the request on its method, and through it the route. Each
 * framework has a same-named decoy (`PlayerService.load`, `carForm.save`) no click may reach.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-angularjs-alpine");

describe("AngularJS 1 and Alpine screens", () => {
  let summary: ProjectAnalysis;
  let out: string;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "cd-ngjs-"));
    await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 180_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const links = () => summary.symbolLinks;
  /** The handler a template's click joins, and the routes its calls reach. */
  const reach = (page: string, handler: string) => {
    const first = links().filter((l) => l.sourceFile === page && l.sourceSymbol === "<component>" && l.callName === handler);
    const routes = new Set<string>();
    const handlers = first.map((l) => `${l.targetFile.replace(/^web\//, "")}::${l.targetSymbol}`).sort();
    const seen = new Set<string>();
    const walk = (file: string, symbol: string) => {
      const key = `${file}::${symbol}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const l of links().filter((x) => x.sourceFile === file && x.sourceSymbol === symbol)) {
        if (l.targetSymbol.startsWith("route:")) routes.add(l.targetSymbol.slice(6));
        else walk(l.targetFile, l.targetSymbol);
      }
    };
    for (const l of first) walk(l.targetFile, l.targetSymbol);
    return { handlers, routes: [...routes].sort() };
  };

  it("reads ng-click and ng-submit as inline handlers carrying the scope they sit in", () => {
    const els = (summary.interactiveElements ?? []).filter((e) => e.filePath === "web/angular/index.html");
    expect(els.map((e) => `${e.event} ${e.handler} ${e.componentScope}`)).toEqual([
      "onclick save ClubCtrl",
      "onclick show ClubCtrl",
      "onclick book MatchCtrl",
    ]);
  });

  it("puts a service's $http calls in its members, not in the module's setup", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath === "web/angular/js/club.service.js");
    expect(calls.length).toBe(2);
    const setup = links().filter((l) => l.sourceFile === "web/angular/js/club.service.js" && l.sourceSymbol === "<setup>");
    expect(setup).toEqual([]);
  });

  it("ng-controller: ng-click → controller member → injected service → route", () => {
    expect(reach("web/angular/index.html", "save")).toEqual({ handlers: ["angular/js/club.controller.js::ClubCtrl.save"], routes: ["POST /api/clubs"] });
    expect(reach("web/angular/index.html", "show")).toEqual({ handlers: ["angular/js/club.controller.js::ClubCtrl.show"], routes: ["GET /api/clubs/:id"] });
  });

  it("an array-annotated injection types the renamed parameter (controller-as alias)", () => {
    expect(reach("web/angular/index.html", "book")).toEqual({ handlers: ["angular/js/match.controller.js::MatchCtrl.book"], routes: ["POST /api/matches"] });
  });

  it("a templateUrl a route binds to a controller scopes a partial with no ng-controller ($inject injection)", () => {
    expect(reach("web/angular/views/player.html", "drop")).toEqual({ handlers: ["angular/js/player.controller.js::PlayerCtrl.drop"], routes: ["DELETE /api/players/:id"] });
  });

  it("never reaches the second module's same-named service method", () => {
    const toPlayerLoad = links().filter((l) => l.targetSymbol === "PlayerService.load" && l.sourceSymbol !== "<setup>");
    expect(toPlayerLoad).toEqual([]);
  });

  it("a server module bound by require keeps its name against a client service registered under it", () => {
    const l = links().filter((x) => x.sourceFile === "server/app.js" && x.callName === "PlayerService.load");
    expect(l.map((x) => `${x.targetFile}::${x.targetSymbol}`)).toEqual(["server/player-service.js::load"]);
  });

  it("Alpine: x-data names the registered factory; its own method runs, not the namesake of another component", () => {
    expect(reach("web/alpine/clubs.html", "save")).toEqual({ handlers: ["alpine/js/club-form.js::clubForm.save"], routes: ["POST /api/clubs"] });
    expect(reach("web/alpine/cars.html", "save")).toEqual({ handlers: ["alpine/js/car-form.js::carForm.save"], routes: ["GET /api/cars/:id"] });
  });
});
