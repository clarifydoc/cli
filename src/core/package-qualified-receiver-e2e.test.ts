import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A call on a local, parameter or field whose type is written through its namespace or package
 * (`League.Scouting.Scout s`, `com.example.league.Scout s`) reaches that namespace's class, never a namesake
 * of another namespace.
 */
async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-pkgrecv-"));
  const root = join(dir, "app");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const rows = (summary: ProjectAnalysis, call: RegExp): string[] =>
  (summary.symbolLinks ?? []).filter((l) => call.test(l.callName)).map((l) => `${l.sourceFile}:${l.sourceLine} ${l.callName} -> ${l.targetFile}`).sort();

describe("C# receiver typed with its namespace", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Scout.cs": "namespace League.Scouting { public class Scout { public void Watch() {} } }\n",
      "Decoy.cs": "namespace Garage.Parts { public class Scout { public void Watch() {} } }\n",
      "Main.cs": [
        "namespace App { public class Main {",
        "  private global::League.Scouting.Scout _f = null;",
        "  public void A() { var s = new League.Scouting.Scout(); s.Watch(); }",
        "  public void B(League.Scouting.Scout t) { t.Watch(); }",
        "  public void D() { League.Scouting.Scout u = null; u.Watch(); }",
        "  public void G(global::League.Scouting.Scout g) { g.Watch(); }",
        "  public void F() { _f.Watch(); }",
        "} }",
      ].join("\n"),
    }));
  }, 60_000);
  afterAll(() => done());

  it("a local, a parameter and a field reach the class of the written namespace", () => {
    expect(rows(summary, /\.Watch$/)).toEqual([
      "Main.cs:3 s.Watch -> Scout.cs",
      "Main.cs:4 t.Watch -> Scout.cs",
      "Main.cs:5 u.Watch -> Scout.cs",
      "Main.cs:6 g.Watch -> Scout.cs",
      "Main.cs:7 _f.Watch -> Scout.cs",
    ]);
  });
});

describe("Java receiver typed with its package", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "a/Scout.java": "package com.example.league;\npublic class Scout { public void watch() {} }\n",
      "b/Scout.java": "package com.example.garage;\npublic class Scout { public void watch() {} }\n",
      "c/Main.java": [
        "package com.example.app;",
        "public class Main {",
        "  private com.example.league.Scout f;",
        "  public void a() { var s = new com.example.league.Scout(); s.watch(); }",
        "  public void b(com.example.league.Scout t) { t.watch(); }",
        "  public void d() { com.example.league.Scout u = null; u.watch(); }",
        "  public void e() { f.watch(); }",
        "}",
      ].join("\n"),
    }));
  }, 60_000);
  afterAll(() => done());

  it("Java: a local, a parameter and a field reach the class of the written package", () => {
    expect(rows(summary, /\.watch$/)).toEqual([
      "c/Main.java:4 s.watch -> a/Scout.java",
      "c/Main.java:5 t.watch -> a/Scout.java",
      "c/Main.java:6 u.watch -> a/Scout.java",
      "c/Main.java:7 f.watch -> a/Scout.java",
    ]);
  });

});

describe("Kotlin receiver typed with its package", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "a/Scout.kt": "package com.example.league\nclass Scout { fun watch() {} }\n",
      "b/Scout.kt": "package com.example.garage\nclass Scout { fun watch() {} }\n",
      "c/Main.kt": [
        "package com.example.app",
        "class Main {",
        "  private val f: com.example.league.Scout = com.example.league.Scout()",
        "  fun a() { val s = com.example.league.Scout(); s.watch() }",
        "  fun b(t: com.example.league.Scout) { t.watch() }",
        "  fun d() { val u: com.example.league.Scout = f; u.watch() }",
        "  fun e() { f.watch() }",
        "}",
      ].join("\n"),
    }));
  }, 60_000);
  afterAll(() => done());

  it("Kotlin: a local, a parameter and a field reach the class of the written package", () => {
    expect(rows(summary, /\.watch$/)).toEqual([
      "c/Main.kt:4 s.watch -> a/Scout.kt",
      "c/Main.kt:5 t.watch -> a/Scout.kt",
      "c/Main.kt:6 u.watch -> a/Scout.kt",
      "c/Main.kt:7 f.watch -> a/Scout.kt",
    ]);
  });
});
