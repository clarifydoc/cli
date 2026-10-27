import { describe, it, expect } from "vitest";
import { composeScreenNavigation } from "./screen-navigation.js";
import { createEmptyAnalysis, type FileAnalysis, type UiComponentInfo } from "../types/analysis.js";

function file(path: string, components: UiComponentInfo[], screens: string[] = [], projectId = "app"): FileAnalysis {
  const a = createEmptyAnalysis(path, "dart");
  a.projectId = projectId;
  a.uiComponents = components;
  a.screens = screens.map((name) => ({ name, formType: "FlutterPage", caption: null, dimensions: null, components: [], filePath: path, routePath: null, navigatesTo: [] }));
  return a;
}
const c = (name: string, builds: string[], navigatesTo: string[] = [], extra: Partial<UiComponentInfo> = {}): UiComponentInfo => ({ name, line: 1, builds, navigatesTo, ...extra });
const nav = (analyses: FileAnalysis[]) => analyses.flatMap((a) => a.screens.map((s) => `${s.name} → ${[...s.navigatesTo].sort().join(", ")}`));

describe("composeScreenNavigation", () => {
  it("gives a screen the navigation of the components of other files it builds, transitively", () => {
    const analyses = [
      file("lib/pages/garage.page.dart", [c("GaragePage", ["CarList", "Text"])], ["GaragePage"]),
      file("lib/widgets/car_list.dart", [c("CarList", ["CarTile"], ["ServiceHistoryPage"])]),
      file("lib/widgets/car_tile.dart", [c("CarTile", [], ["CarDetailPage"])]),
    ];
    expect(composeScreenNavigation(analyses, {})).toBe(2);
    expect(nav(analyses)).toEqual(["GaragePage → CarDetailPage, ServiceHistoryPage"]);
  });

  it("never goes through another screen, never guesses between two components of one name, never into tests", () => {
    const analyses = [
      file("lib/pages/shell.page.dart", [c("ShellPage", ["GaragePage", "TyreCard", "PitBoard"])], ["ShellPage"]),
      file("lib/pages/garage.page.dart", [c("GaragePage", [], ["CarDetailPage"])], ["GaragePage"]),
      file("lib/widgets/tyre_card.dart", [c("TyreCard", [], ["TyrePage"])]),
      file("lib/legacy/tyre_card.dart", [c("TyreCard", [], ["OldTyrePage"])]),
      file("test/widgets/pit_board.dart", [c("PitBoard", [], ["PitPage"])]),
    ];
    expect(composeScreenNavigation(analyses, {})).toBe(0);
    // The one the builder imports is chosen.
    expect(composeScreenNavigation(analyses, { "lib/pages/shell.page.dart": ["lib/widgets/tyre_card.dart"] })).toBe(1);
    expect(nav(analyses)[0]).toBe("ShellPage → TyrePage");
  });

  it("follows a parameter's default widget only from a builder that leaves the parameter out", () => {
    const analyses = [
      file("lib/pages/garage.page.dart", [c("GaragePage", ["Timeline"])], ["GaragePage"]),
      file("lib/pages/showroom.page.dart", [c("ShowroomPage", ["Timeline", "ShowroomBar"], [], { passes: { Timeline: ["appBar"] } })], ["ShowroomPage"]),
      file("lib/widgets/timeline.dart", [c("Timeline", ["StatusButton"], [], { defaults: { appBar: ["MainAppBar"] } })]),
      file("lib/widgets/main_app_bar.dart", [c("MainAppBar", [], ["PitPage"])]),
      file("lib/widgets/status_button.dart", [c("StatusButton", [], ["DownloadPage"])]),
      file("lib/widgets/showroom_bar.dart", [c("ShowroomBar", [], ["SlideshowPage"])]),
    ];
    composeScreenNavigation(analyses, {});
    expect(nav(analyses)).toEqual(["GaragePage → DownloadPage, PitPage", "ShowroomPage → DownloadPage, SlideshowPage"]);
  });
});
