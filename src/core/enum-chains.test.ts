import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const targets = (s: ProjectAnalysis, from: string, callName: string): string[] =>
  s.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetFile.split("/").pop()}:${l.targetSymbol}`).sort();

describe("an enum's entries and values() reached by an index or first()", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-enum-chains-"));
    const files: Record<string, string> = {
      "Position.kt": "package com.example.league\nenum class Position { KEEPER; fun label(): String = name }\n",
      "Shirt.kt": "package com.example.league\nclass Shirt { fun label(): String = \"\" }\n",
      "UseKt.kt": `package com.example.league
class UseKt {
  fun a() = Position.entries.first().label()
  fun b() = Position.entries[0].label()
  fun c() = Position.values()[0].label()
}
`,
      "Role.java": "package com.example.league;\npublic enum Role { COACH; public String label() { return name(); } }\n",
      "Badge.java": "package com.example.league;\nclass Badge { String label() { return \"\"; } static Badge[] values() { return null; } }\n",
      "UseJava.java": `package com.example.league;
class UseJava {
  String a() { return Role.values()[0].label(); }
  String b() { return Badge.values()[0].label(); }
  String c(java.util.List<Role> roles) { return Role.valueOf("COACH").label(); }
}
`,
      "Club.java": "package com.example.league;\nimport org.immutables.value.Value;\n@Value.Immutable\nabstract class Club { abstract String name(); @Value.Default int points() { return 0; } }\n",
      "UseClub.java": "package com.example.league;\nclass UseClub { void f() { ImmutableClub.builder().name(\"a\").points(3).build(); } }\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("links Kotlin entries.first(), entries[i] and values()[i] to the enum's own member", () => {
    expect(targets(summary, "UseKt.a", "Position.entries.first().label")).toEqual(["Position.kt:Position.label"]);
    expect(targets(summary, "UseKt.b", "Position.entries[0].label")).toEqual(["Position.kt:Position.label"]);
    expect(targets(summary, "UseKt.c", "Position.values()[0].label")).toEqual(["Position.kt:Position.label"]);
  });

  it("links a Java array element of values() to the enum, and a project values() of another class to that class", () => {
    expect(targets(summary, "UseJava.a", "Role.values()[0].label")).toEqual(["Role.java:Role.label"]);
    expect(targets(summary, "UseJava.b", "Badge.values()[0].label")).toEqual(["Badge.java:Badge.label"]);
  });

  it("links a @Value.Default attribute on the generated builder", () => {
    expect(targets(summary, "UseClub.f", 'ImmutableClub.builder().name("a").points')).toHaveLength(1);
  });
});
