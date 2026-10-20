import { describe, expect, it } from "vitest";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../../types/analysis.js";
import { androidNavGraphFacts } from "../../shared/android-nav-graph.js";
import { extractAndroidNavigation } from "./android-nav.js";
import { androidNavGraphResolver } from "./android-nav-graph.js";
import type { ProjectContext } from "../../../../types/project.js";

const graph = (path: string, xml: string): FileAnalysis => {
  const facts: RouteFact[] = [];
  androidNavGraphFacts(xml.split("\n"), facts);
  return { ...createEmptyAnalysis(path, "springxml"), routeFacts: facts };
};
const kotlin = (path: string, cls: string, src: string): FileAnalysis => ({
  ...createEmptyAnalysis(path, "kotlin"),
  classes: [{ name: cls, extends: "Fragment", implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 20 }],
  routes: extractAndroidNavigation(src),
});
const NS = 'xmlns:android="http://schemas.android.com/apk/res/android" xmlns:app="http://schemas.android.com/apk/res-auto"';

describe("Android navigation graphs", () => {
  it("opens a nested graph's start destination, and names nothing for an id two graphs disagree on", () => {
    const main = graph("res/navigation/main.xml", `<navigation ${NS} app:startDestination="@id/home">
  <fragment android:id="@+id/home" android:name="a.HomeFragment">
    <action android:id="@+id/to_settings" app:destination="@id/settings_graph"/>
  </fragment>
  <navigation android:id="@+id/settings_graph" app:startDestination="@id/settings">
    <fragment android:id="@+id/settings" android:name="a.SettingsFragment"/>
  </navigation>
  <fragment android:id="@+id/detail" android:name="a.DetailFragment"/>
</navigation>`);
    const other = graph("res/navigation/other.xml", `<navigation ${NS}>
  <fragment android:id="@+id/detail" android:name="b.OtherDetailFragment"/>
</navigation>`);
    const home = kotlin("HomeFragment.kt", "HomeFragment", "class HomeFragment : Fragment() {\n  fun a() { findNavController().navigate(R.id.detail) }\n}");
    const settings = kotlin("SettingsFragment.kt", "SettingsFragment", "class SettingsFragment : Fragment()");
    const files = [main, other, home, settings];
    androidNavGraphResolver.resolve(files, {} as ProjectContext);
    // The graph's action reaches the nested graph, whose start is SettingsFragment; `detail` is two classes: dropped.
    expect(home.routes.map((r) => `${r.line} ${r.path}`)).toEqual(["1 SettingsFragment"]);
  });
});
