import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { kotlinFacadeClass } from "./kotlin-facade.js";

describe("Kotlin facade class names", () => {
  it("names a file's functions after the file, or after @file:JvmName", () => {
    expect(kotlinFacadeClass("package league\nfun rank() = 1", "src/Clubs.kt")).toBe("ClubsKt");
    expect(kotlinFacadeClass("package league\nfun rank() = 1", "src/club-table.kt")).toBe("Club_tableKt");
    expect(kotlinFacadeClass('@file:JvmName("ScoreBoard")\npackage league', "src/Scores.kt")).toBe("ScoreBoard");
    expect(kotlinFacadeClass("fun x() = 1", "build.gradle.kts")).toBeNull();
  });
});

describe("Java calling Kotlin through its JVM names", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>league</artifactId><version>1</version></project>",
    "src/main/kotlin/com/example/league/Clubs.kt": `package com.example.league

fun rank(points: Int): Int = points * 2

object Referee {
    fun whistle(): String = "pip"
}

class Club(val name: String, var points: Int, private val secret: String, val isActive: Boolean) {
    companion object {
        fun build(): Club = Club("x", 0, "s", true)
    }
    fun total(): Int = points
}
`,
    "src/main/kotlin/com/example/league/Scores.kt": `@file:JvmName("ScoreBoard")
package com.example.league

fun tally(n: Int): Int = n + 1
`,
    "src/main/java/com/example/league/Holder.java": `package com.example.league;

public class Holder {
    public static final Pitch INSTANCE = new Pitch();
}
`,
    "src/main/java/com/example/league/Pitch.java": `package com.example.league;

public class Pitch {
    public void mow() {}
}
`,
    "src/main/java/com/example/league/Garage.java": `package com.example.league;

public class Garage {
    public int run(Club club) {
        ClubsKt.rank(3);
        Referee.INSTANCE.whistle();
        Club.Companion.build();
        ScoreBoard.tally(2);
        ScoresKt.tally(2);
        club.getName();
        club.setPoints(3);
        club.isActive();
        club.getSecret();
        Holder.INSTANCE.mow();
        return club.total();
    }
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-kt-interop-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (callName: string) =>
    summary.symbolLinks.filter((l) => l.callName === callName && l.sourceSymbol === "Garage.run").map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`);

  it("reaches a top-level function through its facade class, named or @file:JvmName'd", () => {
    expect(target("ClubsKt.rank")).toEqual(["Clubs.kt::rank"]);
    expect(target("ScoreBoard.tally")).toEqual(["Scores.kt::tally"]);
    // The default facade name is gone once @file:JvmName renames it.
    expect(target("ScoresKt.tally")).toEqual([]);
  });

  it("reaches an object's and a companion's members through INSTANCE and Companion", () => {
    expect(target("Referee.INSTANCE.whistle")).toEqual(["Clubs.kt::Referee.whistle"]);
    expect(target("Club.Companion.build")).toEqual(["Clubs.kt::Club.build"]);
  });

  it("keeps the typed reading where the class declares a field of that name", () => {
    expect(target("Holder.INSTANCE.mow")).not.toContain("Holder.java::Holder.mow");
  });

  it("reaches a property through its getter and setter, never a private one", () => {
    expect(target("club.getName")).toEqual(["Clubs.kt::Club.getName"]);
    expect(target("club.setPoints")).toEqual(["Clubs.kt::Club.setPoints"]);
    expect(target("club.isActive")).toEqual(["Clubs.kt::Club.isActive"]);
    expect(target("club.getSecret")).toEqual([]);
  });
});
