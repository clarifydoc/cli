import { describe, it, expect } from "vitest";
import { AndroidManifestComponentsResolver } from "./android-manifest-components.js";
import { androidManifestFacts } from "../shared/android-manifest.js";
import type { ClassInfo, FileAnalysis, RouteFact } from "../../../types/analysis.js";

const manifestText = `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.league">
  <application android:name=".LeagueApp">
    <!-- <activity android:name=".ui.Ghost"/> -->
    <activity android:name=".ui.ClubActivity"/>
    <service android:name="com.example.league.sync.TrainingService"/>
  </application>
</manifest>`;

function manifest(text = manifestText): FileAnalysis {
  const facts: RouteFact[] = [];
  androidManifestFacts(text.split("\n"), facts);
  return { filePath: "app/src/main/AndroidManifest.xml", language: "springxml", classes: [], functions: [], routeFacts: facts } as unknown as FileAnalysis;
}
const code = (filePath: string, packageName: string, name: string): FileAnalysis =>
  ({ filePath, language: "java", packageName, functions: [], classes: [{ name, kind: "class", methods: [], line: 3 } as unknown as ClassInfo] }) as unknown as FileAnalysis;

describe("AndroidManifestComponentsResolver", () => {
  it("links the manifest to the classes it names, resolved against its package", () => {
    const links = new AndroidManifestComponentsResolver().resolve([
      manifest(),
      code("app/src/main/java/com/example/league/ui/ClubActivity.java", "com.example.league.ui", "ClubActivity"),
      code("app/src/main/java/com/example/league/other/ClubActivity.java", "com.example.league.other", "ClubActivity"),
      code("app/src/main/java/com/example/league/sync/TrainingService.java", "com.example.league.sync", "TrainingService"),
      code("app/src/main/java/com/example/league/ui/PlayerActivity.java", "com.example.league.ui", "PlayerActivity"),
      code("app/src/main/java/com/example/league/LeagueApp.java", "com.example.league", "LeagueApp"),
      code("lib/src/main/java/com/example/league/ui/ClubActivity.java", "com.example.league.ui", "ClubActivity"),
    ]);
    expect(links.map((l) => l.targetFile).sort()).toEqual([
      "app/src/main/java/com/example/league/LeagueApp.java",
      "app/src/main/java/com/example/league/sync/TrainingService.java",
      "app/src/main/java/com/example/league/ui/ClubActivity.java",
    ]);
  });

  it("reads a manifest with no package by the package that ends with the written path", () => {
    const links = new AndroidManifestComponentsResolver().resolve([
      manifest(manifestText.replace(' package="com.example.league"', "")),
      code("app/src/main/java/com/example/league/ui/ClubActivity.java", "com.example.league.ui", "ClubActivity"),
      code("app/src/main/java/com/example/league/other/ClubActivity.java", "com.example.league.other", "ClubActivity"),
    ]);
    expect(links.map((l) => l.targetFile)).toEqual(["app/src/main/java/com/example/league/ui/ClubActivity.java"]);
  });
});
