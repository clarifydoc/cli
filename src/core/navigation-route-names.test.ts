import { describe, it, expect } from "vitest";
import { canonicalNavigationTargets } from "./analyzer.js";
import type { ScreenInfo } from "../types/analysis.js";

const page = (filePath: string, navigatesTo: string[]): ScreenInfo => ({
  name: filePath, formType: "page", caption: null, dimensions: null, components: [], filePath, routePath: null, navigatesTo,
});
const route = (path: string, projectId: string, extra: { name?: string; derivedName?: string }) => ({ path, projectId, kind: "api", ...extra });

describe("a route name a screen navigates to", () => {
  const projectOf = (f: string) => f.split("/")[0];
  const resolve = (routes: Array<ReturnType<typeof route>>) => {
    const screens = [page("a/Home.vue", ["route:clubs.show"])];
    canonicalNavigationTargets(screens, routes, projectOf);
    return screens[0]!.navigatesTo;
  };

  it("takes the caller's own derived name over another sub-project's stated one", () => {
    expect(resolve([route("/a/clubs", "a", { derivedName: "clubs.show" }), route("/b/clubs", "b", { name: "clubs.show" })])).toEqual(["/a/clubs"]);
  });

  it("takes the caller's own stated name when both sub-projects state it", () => {
    expect(resolve([route("/a/clubs", "a", { name: "clubs.show" }), route("/b/clubs", "b", { name: "clubs.show" })])).toEqual(["/a/clubs"]);
  });

  it("reads another sub-project's stated name when the caller's own has none", () => {
    expect(resolve([route("/b/clubs", "b", { name: "clubs.show" })])).toEqual(["/b/clubs"]);
  });

  it("stays as written when two other sub-projects state it differently", () => {
    expect(resolve([route("/b/clubs", "b", { name: "clubs.show" }), route("/c/clubs", "c", { name: "clubs.show" })])).toEqual(["route:clubs.show"]);
  });
});
