import { describe, expect, it } from "vitest";
import type { FileAnalysis, ScreenInfo } from "../types/analysis.js";
import { joinTestNavigations } from "./test-navigations.js";

const screen = (filePath: string, routePath?: string, otherRoutes?: string[]): ScreenInfo =>
  ({ name: filePath.replace(/^.*\/|\..*$/g, ""), formType: "VuePage", caption: null, dimensions: null, components: [], filePath, navigatesTo: [], ...(routePath !== undefined ? { routePath } : {}), ...(otherRoutes ? { otherRoutes } : {}) }) as ScreenInfo;

const file = (filePath: string, projectId: string, nav: Array<[string, number]>, functions: Array<[string, number, number]> = []) =>
  ({
    filePath,
    projectId,
    classes: [],
    functions: functions.map(([name, line, endLine]) => ({ name, line, endLine })),
    browserNavigations: nav.map(([path, line]) => ({ path, line })),
  }) as unknown as FileAnalysis;

describe("pages browser tests open", () => {
  const screens = [
    screen("web/src/views/Squad.vue", "/clubs/:clubId/squad"),
    screen("web/src/views/ClubSettings.vue", "/clubs/:clubId/settings/:section"),
    screen("web/src/views/Login.vue", "/login"),
    screen("web/src/views/Home.vue", "/"),
    screen("admin/src/League.vue", "league", ["league/:section"]),
    screen("web/src/components/Badge.vue"),
  ];
  const projectOf = (f: string) => (f.startsWith("admin/") ? "admin" : f.startsWith("e2e/") ? "e2e" : "web");
  const isTest = (f: string) => /(?:^e2e\/|\/tests\/)/.test(f);

  it("joins each navigation of test code to the screen at its path, in the enclosing test", () => {
    const rows = joinTestNavigations({
      analyses: [
        file("web/tests/e2e/squad.spec.ts", "web", [["/clubs/{}/squad", 4], ["/clubs/1/settings/kits", 9], ["/login", 12], ["/", 15], ["/standings", 16]], [["shows the squad", 3, 10], ["signs in", 11, 13]]),
        // A suite of its own: the app reached by URL, the one screen at the path in any sub-project.
        file("e2e/league.spec.ts", "e2e", [["/league/fixtures", 2]]),
        // Production code driving a browser (a scraper) is no test.
        file("web/src/scraper.ts", "web", [["/login", 3]]),
      ],
      screens,
      projectOf,
      isTest,
    });
    expect(rows).toEqual([
      { file: "e2e/league.spec.ts", line: 2, path: "/league/fixtures", screens: ["admin/src/League.vue"] },
      { file: "web/tests/e2e/squad.spec.ts", line: 4, symbol: "shows the squad", path: "/clubs/{}/squad", screens: ["web/src/views/Squad.vue"] },
      { file: "web/tests/e2e/squad.spec.ts", line: 9, symbol: "shows the squad", path: "/clubs/1/settings/kits", screens: ["web/src/views/ClubSettings.vue"] },
      { file: "web/tests/e2e/squad.spec.ts", line: 12, symbol: "signs in", path: "/login", screens: ["web/src/views/Login.vue"] },
      { file: "web/tests/e2e/squad.spec.ts", line: 15, path: "/", screens: ["web/src/views/Home.vue"] },
      { file: "web/tests/e2e/squad.spec.ts", line: 16, path: "/standings" },
    ]);
  });

  it("a nested route's layout and its index page both answer; two apps serving the path neither", () => {
    const rows = joinTestNavigations({
      analyses: [file("e2e/home.spec.ts", "e2e", [["/", 1], ["/garage", 2]])],
      screens: [
        screen("web/src/views/Home.vue", "/"),
        screen("admin/src/Home.vue", "/"),
        screen("web/src/views/GarageShell.vue", "/garage"),
        screen("web/src/views/GarageOverview.vue", "/garage"),
      ],
      projectOf,
      isTest,
    });
    expect(rows).toEqual([
      { file: "e2e/home.spec.ts", line: 1, path: "/" },
      { file: "e2e/home.spec.ts", line: 2, path: "/garage", screens: ["web/src/views/GarageOverview.vue", "web/src/views/GarageShell.vue"] },
    ]);
  });
});
