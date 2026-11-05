import { describe, expect, it } from "vitest";
import type { FileAnalysis, ProjectAnalysis, ScreenInfo } from "../types/analysis.js";
import { fileTestVerdict } from "./test-functions.js";
import { joinTestNavigations, pagePartsOf } from "./test-navigations.js";

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

  it("a nested route's layout and its index page both answer; two apps serving the path neither, nor one app's home from another sub-project", () => {
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
    // One app at `/`, the suite a package of its own: the home of which app is served there, unknown.
    expect(joinTestNavigations({ analyses: [file("e2e/home.spec.ts", "e2e", [["/", 1]])], screens: [screen("web/src/views/Home.vue", "/")], projectOf, isTest }))
      .toEqual([{ file: "e2e/home.spec.ts", line: 1, path: "/" }]);
  });
});

describe("what a page a browser test opens is made of", () => {
  const ui = [
    "web/src/App.vue",
    "web/src/components/AppSidebar.vue",
    "web/src/components/SidebarClub.vue",
    "web/src/components/PlayerCard.vue",
    "web/src/components/DatePicker.vue",
    "web/src/components/datepicker/CalendarMonth.vue",
    "web/src/components/Button.vue",
    "web/src/components/Icon.vue",
    "web/src/components/TransferList.vue",
  ];
  // Twenty-one pages render the button: a shared component.
  const many = Array.from({ length: 21 }, (_, i) => `web/src/views/Page${i}.vue`);
  const screens = [
    screen("web/src/views/Squad.vue", "/clubs/:clubId/squad"),
    screen("web/src/views/Login.vue", "/login"),
    ...many.map((f, i) => screen(f, `/page${i}`)),
    ...ui.map((f) => screen(f)),
  ];
  const uses: Record<string, string[]> = {
    "web/src/main.ts": ["web/src/router.ts", "web/src/App.vue", "web/src/stores/session.ts"],
    "web/src/router.ts": ["web/src/views/Squad.vue", "web/src/views/Login.vue"],
    "web/src/App.vue": ["web/src/components/AppSidebar.vue", "web/src/composables/useTheme.ts"],
    "web/src/components/AppSidebar.vue": ["web/src/components/SidebarClub.vue"],
    "web/src/views/Squad.vue": ["web/src/components/PlayerCard.vue", "web/src/composables/useSquad.ts", "web/src/components/Button.vue", "web/src/views/Login.vue"],
    "web/src/composables/useSquad.ts": ["web/src/api/squad.ts"],
    "web/src/components/PlayerCard.vue": ["web/src/components/DatePicker.vue", "web/tests/fixtures/players.ts"],
    "web/src/components/DatePicker.vue": ["web/src/components/datepicker/CalendarMonth.vue"],
    "web/src/components/Button.vue": ["web/src/components/Icon.vue"],
    "web/src/components/TransferList.vue": ["web/src/components/Button.vue"],
    ...Object.fromEntries(many.map((f) => [f, ["web/src/components/Button.vue"]])),
  };
  const run = (mounts: string[]) => {
    const rows = joinTestNavigations({
      analyses: [file("web/tests/e2e/squad.spec.ts", "web", [["/clubs/{}/squad", 4], ["/standings", 8]], [["shows the squad", 3, 10]])],
      screens,
      projectOf: () => "web",
      isTest: (f) => f.includes("/tests/"),
    });
    const parts = pagePartsOf({
      rows,
      uses,
      imports: uses,
      screens,
      routeFiles: new Set(["web/src/router.ts"]),
      mounts,
      projectOf: () => "web",
      isTest: (f) => f.includes("/tests/"),
    });
    return { rows, parts };
  };

  it("the page's components and the modules they use, and the app start with its root component", () => {
    const { rows, parts } = run(["web/src/main.ts"]);
    expect(rows[0]).toMatchObject({ screens: ["web/src/views/Squad.vue"], entry: "web/src/main.ts" });
    expect(parts).toEqual({
      // Another page is no part; a shared component is, what lies below it is not; a module's own
      // imports (the api client below a composable) are code depending on code; test fixtures never.
      "web/src/views/Squad.vue": [
        "web/src/components/Button.vue",
        "web/src/components/DatePicker.vue",
        "web/src/components/PlayerCard.vue",
        "web/src/components/datepicker/CalendarMonth.vue",
        "web/src/composables/useSquad.ts",
      ],
      // The route table runs, the pages it lists are not opened by it.
      "web/src/main.ts": [
        "web/src/App.vue",
        "web/src/components/AppSidebar.vue",
        "web/src/components/SidebarClub.vue",
        "web/src/composables/useTheme.ts",
        "web/src/router.ts",
        "web/src/stores/session.ts",
      ],
    });
  });

  it("an app start whose imports do not reach the page, or two that do, start none", () => {
    expect(run(["web/src/widget.ts"]).rows[0]!.entry).toBeUndefined();
    const two = { ...uses, "web/src/admin.ts": ["web/src/router.ts"] };
    const rows = joinTestNavigations({
      analyses: [file("web/tests/e2e/squad.spec.ts", "web", [["/clubs/{}/squad", 4]])],
      screens,
      projectOf: () => "web",
      isTest: (f) => f.includes("/tests/"),
    });
    pagePartsOf({ rows, uses: two, imports: two, screens, routeFiles: new Set(["web/src/router.ts"]), mounts: ["web/src/main.ts", "web/src/admin.ts"], projectOf: () => "web", isTest: (f) => f.includes("/tests/") });
    expect(rows[0]!.entry).toBeUndefined();
  });

  it("the test verdict: tested by navigation, with the test and the page it opens", () => {
    const { rows, parts } = run(["web/src/main.ts"]);
    const summary = { symbolLinks: [], testNavigations: rows, pageParts: parts } as unknown as ProjectAnalysis;
    const verdict = (path: string) => {
      const v = fileTestVerdict(summary, path, { functions: [{ name: "setup", line: 1 }], classes: [] } as never);
      return `${v.state}${v.basis.length ? ` (${v.basis.join(", ")})` : ""}`;
    };
    expect(verdict("web/src/components/datepicker/CalendarMonth.vue")).toBe("tested (navigation)");
    expect(verdict("web/src/components/SidebarClub.vue")).toBe("tested (navigation)");
    expect(verdict("web/src/main.ts")).toBe("tested (navigation)");
    expect(verdict("web/src/components/Icon.vue")).toBe("untested");
    expect(verdict("web/src/components/TransferList.vue")).toBe("untested");
    expect(verdict("web/src/api/squad.ts")).toBe("untested");
    expect(verdict("web/src/views/Login.vue")).toBe("untested");
    expect(fileTestVerdict(summary, "web/src/components/PlayerCard.vue", { functions: [{ name: "setup", line: 1 }], classes: [] } as never).navigation).toEqual({
      test: { file: "web/tests/e2e/squad.spec.ts", line: 4, symbol: "shows the squad" },
      path: "/clubs/{}/squad",
      page: "web/src/views/Squad.vue",
    });
  });
});
