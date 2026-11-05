import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** C#, Java and Kotlin names that need an import or a label to be read: static usings, namespace aliases, nested static imports, `this@Label`, infix calls. */
const FILES: Record<string, string> = {
  "cs/Scoring.cs": `namespace League.Scoring { public static class Scorer { public static int Award(int g) => g; } }\n`,
  "cs/Decoy.cs": `namespace League.Other { public static class Referee { public static int Award(int g) => g; } }\n`,
  "cs/Calendar.cs": `namespace League.Fixtures { public class Calendar { public static int Build() => 1; } }\n`,
  "cs/OtherCalendar.cs": `namespace League.Other { public class Calendar { public static int Build() => 2; } }\n`,
  "cs/Use.cs": `using static League.Scoring.Scorer;
using Fx = League.Fixtures;
namespace League.App {
  public class Runner {
    public int Run() { var a = Award(3); return a + Fx.Calendar.Build(); }
  }
}
`,
  "java/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>league</artifactId><version>1</version></project>\n`,
  "java/src/main/java/com/example/league/Club.java": `package com.example.league;
public class Club { public static class Status { public static boolean active() { return true; } } }
`,
  "java/src/main/java/com/example/league/Garage.java": `package com.example.league;
public class Garage { public static class Status { public static boolean active() { return false; } } }
`,
  "java/src/main/java/com/example/league/Use.java": `package com.example.league;
import static com.example.league.Club.Status.active;
public class Use { public boolean go() { return active(); } }
`,
  "kotlin/build.gradle.kts": `plugins { kotlin("jvm") version "1.9.0" }\n`,
  "kotlin/src/main/kotlin/league/Club.kt": `package league

class Club {
    infix fun scores(goals: Int): Int = goals
}
`,
  "kotlin/src/main/kotlin/league/Garage.kt": `package league

class Garage {
    infix fun scores(laps: Int): Int = laps
    fun save() {}
}
`,
  "kotlin/src/main/kotlin/league/ClubScreen.kt": `package league

class ClubScreen {
    fun save() {}
    fun saveAll() {}
    fun render(club: Club, bus: Bus) {
        val task = object : Runnable { override fun run() { this@ClubScreen.save() } }
        club scores 3
        bus.on(this::saveAll)
        val later = ::saveClub
    }
}

fun saveClub(c: Club) {}
`,
};

describe("C# and Java names an import or a label gives", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-jvm-dotnet-names-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const linkOf = (file: string, symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.confidence}` : null;
  };
  it("links a C# `using static` member called bare, never a namesake of another namespace", () => {
    expect(linkOf("cs/Use.cs", "Runner.Run", "Award")).toMatch(/^cs\/Scoring\.cs Scorer\.Award /);
  });
  it("links a C# namespace alias's type", () => {
    expect(linkOf("cs/Use.cs", "Runner.Run", "Fx.Calendar.Build")).toMatch(/^cs\/Calendar\.cs Calendar\.Build /);
  });
  it("links Kotlin's labelled this, infix call and callable references on the class they name", () => {
    const screen = "kotlin/src/main/kotlin/league/ClubScreen.kt";
    expect(linkOf(screen, "ClubScreen.render", "ClubScreen.save")).toMatch(/^kotlin\/src\/main\/kotlin\/league\/ClubScreen\.kt ClubScreen\.save /);
    expect(linkOf(screen, "ClubScreen.render", "club.scores")).toMatch(/^kotlin\/src\/main\/kotlin\/league\/Club\.kt Club\.scores /);
    expect(summary.symbolLinks.some((l) => l.sourceFile === screen && l.callName === "club.scores" && l.targetFile.endsWith("Garage.kt"))).toBe(false);
    const passes = summary.symbolLinks.filter((l) => l.sourceFile === screen && l.relation === "passes").map((l) => l.targetSymbol).sort();
    expect(passes).toEqual(["ClubScreen.saveAll", "saveClub"]);
  });
  it("links a Java static import of a nested type's member", () => {
    expect(linkOf("java/src/main/java/com/example/league/Use.java", "Use.go", "active")).toMatch(/Club\.java Club\.Status\.active |Club\.java Status\.active /);
  });
});
