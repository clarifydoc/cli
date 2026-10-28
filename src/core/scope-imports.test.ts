import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Imports that put a module's members in scope by bare name (`ImportInfo.inScope`):
 * Java static imports, Kotlin function and object-member imports, Go dot
 * imports, Elixir `import`, Dart imports and `part`s.
 */
const FILES: Record<string, string> = {
  // ── Java ──
  "java/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>league</artifactId><version>1</version></project>\n`,
  "java/src/main/java/com/example/scoring/Scores.java": `package com.example.scoring;

public class Scores {
    public static int tally(int goals) {
        return goals + 1;
    }

    public static int bonus(int goals) {
        return goals * 2;
    }
}
`,
  "java/src/main/java/com/example/league/Match.java": `package com.example.league;

import static com.example.scoring.Scores.tally;

public class Match {
    public int play() {
        return tally(1);
    }
}
`,
  "java/src/main/java/com/example/league/Cup.java": `package com.example.league;

import static com.example.scoring.Scores.*;

public class Cup {
    public int play() {
        return bonus(tally(2));
    }
}
`,
  // ── Kotlin ──
  "kotlin/build.gradle.kts": `plugins { kotlin("jvm") version "1.9.0" }\n`,
  "kotlin/src/main/kotlin/league/util/Whistle.kt": `package league.util

fun blowFullTime(): Int {
    return 90
}
`,
  "kotlin/src/main/kotlin/league/rules/Limits.kt": `package league.rules

object Limits {
    fun substitutes(): Int = 5
}
`,
  "kotlin/src/main/kotlin/league/rules/Timing.kt": `package league.rules

object Stopwatch {
    fun tick(): Int = 1
}
`,
  "kotlin/src/main/kotlin/league/app/Referee.kt": `package league.app

import league.util.blowFullTime
import league.rules.Limits.substitutes
import league.rules.Stopwatch

class Referee {
    fun finish(): Int {
        Stopwatch.tick()
        return blowFullTime() + substitutes()
    }
}
`,
  // A same-named class in another package (generated table classes) is never the imported one.
  "kotlin/src/main/kotlin/league/model/Kit.kt": `package league.model

class Kit(val colour: String)
`,
  "kotlin/src/main/kotlin/league/persistent/tables/Kit.java": `package league.persistent.tables;

public class Kit {
    public Kit(String alias) {
    }
}
`,
  "kotlin/src/main/kotlin/league/app/KitRoom.kt": `package league.app

import league.model.Kit

class KitRoom {
    fun issue(): Kit {
        return Kit("red")
    }
}
`,
  // ── Go ──
  "go/go.mod": "module example.com/league\n\ngo 1.21\n",
  "go/garage/wash.go": `package garage

func Wash(n int) int {
	return n + 1
}

func polish(n int) int {
	return n
}
`,
  "go/cmd/main.go": `package main

import . "example.com/league/garage"

func main() {
	Wash(1)
	polish(2)
}
`,
  "go/cmd/polish.go": `package main

func polish(n int) int {
	return n * 2
}
`,
  // ── Elixir ──
  "elixir/mix.exs": `defmodule League.MixProject do
  use Mix.Project
  def project, do: [app: :league, version: "0.1.0"]
end
`,
  "elixir/lib/league/rules.ex": `defmodule League.Rules do
  def offside(x) do
    x + 1
  end

  def foul(x) do
    x
  end
end
`,
  "elixir/lib/league/referee.ex": `defmodule League.Referee do
  import League.Rules

  def judge(x) do
    offside(x)
  end
end
`,
  "elixir/lib/league/var.ex": `defmodule League.Var do
  import League.Rules, only: [foul: 1]

  def review(x) do
    foul(x)
    offside(x)
  end
end
`,
  // ── Dart ──
  "dart/pubspec.yaml": "name: league\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
  "dart/lib/src/util.dart": `int kickoff(int n) {
  return n + 1;
}
`,
  "dart/lib/src/clock.dart": `int kickoff(int n) {
  return n;
}
`,
  "dart/lib/src/io_stub.dart": `String readClub() => 'stub';
`,
  "dart/lib/src/io_web.dart": `String readClub() => 'web';
`,
  "dart/lib/models/club.dart": `import 'package:league/src/util.dart';

part 'club.g.dart';

class Club {
  final String name;
  Club(this.name);

  Map<String, dynamic> toJson() => _$ClubToJson(this);
}
`,
  "dart/lib/models/club.g.dart": `part of 'club.dart';

Map<String, dynamic> _$ClubToJson(Club instance) {
  kickoff(1);
  return {'name': instance.name};
}
`,
  "dart/lib/main.dart": `import 'src/util.dart';
import 'src/io_stub.dart'
    if (dart.library.html) 'src/io_web.dart';

void main() {
  kickoff(1);
  readClub();
}
`,
  "dart/lib/both.dart": `import 'src/util.dart';
import 'src/clock.dart';

void both() {
  kickoff(1);
}
`,
  "dart/lib/prefixed.dart": `import 'src/util.dart' as util;

void prefixed() {
  util.kickoff(1);
  kickoff(2);
}
`,
};

describe("imports that put a callee in scope by name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-scope-imports-"));
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

  it("links a Java static import, single and on demand", () => {
    const scores = "java/src/main/java/com/example/scoring/Scores.java";
    expect(linkOf("java/src/main/java/com/example/league/Match.java", "Match.play", "tally")).toBe(`${scores} Scores.tally EXTRACTED`);
    expect(linkOf("java/src/main/java/com/example/league/Cup.java", "Cup.play", "tally")).toBe(`${scores} Scores.tally INFERRED`);
    expect(linkOf("java/src/main/java/com/example/league/Cup.java", "Cup.play", "bonus")).toBe(`${scores} Scores.bonus INFERRED`);
  });

  it("links a Kotlin top-level function import, an object member import, and an object in a file not named after it", () => {
    const referee = "kotlin/src/main/kotlin/league/app/Referee.kt";
    expect(linkOf(referee, "Referee.finish", "blowFullTime")).toBe("kotlin/src/main/kotlin/league/util/Whistle.kt blowFullTime EXTRACTED");
    expect(linkOf(referee, "Referee.finish", "substitutes")).toBe("kotlin/src/main/kotlin/league/rules/Limits.kt Limits.substitutes EXTRACTED");
    expect(linkOf(referee, "Referee.finish", "Stopwatch.tick")).toBe("kotlin/src/main/kotlin/league/rules/Timing.kt Stopwatch.tick EXTRACTED");
  });

  it("constructs the imported class, never a namesake of another package", () => {
    expect(linkOf("kotlin/src/main/kotlin/league/app/KitRoom.kt", "KitRoom.issue", "Kit")).toBe("kotlin/src/main/kotlin/league/model/Kit.kt Kit EXTRACTED");
  });

  it("links a Go dot import's function, and keeps the caller's own package first", () => {
    expect(linkOf("go/cmd/main.go", "main", "Wash")).toBe("go/garage/wash.go Wash INFERRED");
    expect(linkOf("go/cmd/main.go", "main", "polish")).toBe("go/cmd/polish.go polish EXTRACTED");
  });

  it("links an Elixir import, and only the functions `only:` names", () => {
    expect(linkOf("elixir/lib/league/referee.ex", "League.Referee.judge", "offside")).toBe("elixir/lib/league/rules.ex League.Rules.offside INFERRED");
    expect(linkOf("elixir/lib/league/var.ex", "League.Var.review", "foul")).toBe("elixir/lib/league/rules.ex League.Rules.foul EXTRACTED");
    expect(linkOf("elixir/lib/league/var.ex", "League.Var.review", "offside")).toBeNull();
  });

  it("links a Dart import's top-level function, the default branch of a conditional import, and never a prefixed or doubly imported one", () => {
    expect(linkOf("dart/lib/main.dart", "main", "kickoff")).toBe("dart/lib/src/util.dart kickoff INFERRED");
    expect(linkOf("dart/lib/main.dart", "main", "readClub")).toBe("dart/lib/src/io_stub.dart readClub INFERRED");
    expect(linkOf("dart/lib/both.dart", "both", "kickoff")).toBeNull();
    expect(linkOf("dart/lib/prefixed.dart", "prefixed", "kickoff")).toBeNull();
  });

  it("shares one scope between a Dart library and its part", () => {
    expect(linkOf("dart/lib/models/club.dart", "Club.toJson", "_$ClubToJson")).toBe("dart/lib/models/club.g.dart _$ClubToJson INFERRED");
    expect(linkOf("dart/lib/models/club.g.dart", "_$ClubToJson", "kickoff")).toBe("dart/lib/src/util.dart kickoff INFERRED");
  });
});
