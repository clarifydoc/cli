import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-bounds-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (s: ProjectAnalysis, from: string, call: string): string[] =>
  s.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === call).map((l) => l.targetSymbol).sort();

describe("a type parameter's bound types the parameter written as it (Java)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Car.java": "package com.example.league;\npublic class Car { public void start() {} }\n",
      "Boat.java": "package com.example.league;\npublic class Boat { public void sail() {} }\n",
      "Decoy.java": "package com.example.league;\npublic class Decoy { public void start() {} public void sail() {} }\n",
      "Garage.java": `package com.example.league;
public class Garage<T extends Car> {
  void n(T t) { t.start(); }
  <U extends Boat> void p(U u) { u.sail(); }
  <V> void q(V v) { v.sail(); }
  <W extends Car & Comparable<W>> void r(W w) { w.start(); }
  void local(T t) { T other = t; other.start(); }
}
class Rig<T extends Car> { <T extends Boat> void m(T t) { t.sail(); } <T> void free(T t) { t.start(); } }
`,
    }));
  });
  afterAll(() => done());

  it("links the class bound, the method bound and the first of several", () => {
    expect(targets(summary, "Garage.n", "t.start")).toEqual(["Car.start"]);
    expect(targets(summary, "Garage.p", "u.sail")).toEqual(["Boat.sail"]);
    expect(targets(summary, "Garage.r", "w.start")).toEqual(["Car.start"]);
    expect(targets(summary, "Garage.local", "other.start")).toEqual(["Car.start"]);
  });
  it("prefers the method's own bound, and leaves an unbounded letter untyped", () => {
    expect(targets(summary, "Rig.m", "t.sail")).toEqual(["Boat.sail"]);
    expect(targets(summary, "Rig.free", "t.start")).toEqual([]);
    expect(targets(summary, "Garage.q", "v.sail")).toEqual([]);
  });
  it("never lands on the same-named decoy", () => {
    expect(summary.symbolLinks.filter((l) => l.targetSymbol.startsWith("Decoy."))).toEqual([]);
  });
});

describe("a type parameter's bound types the parameter written as it (Kotlin)", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Models.kt": "package com.example.league\nopen class Car { fun start() {} }\nopen class Boat { fun sail() {} }\nclass Decoy { fun start() {} fun sail() {} }\n",
      "Garage.kt": `package com.example.league
class Garage<T : Car> {
  fun n(t: T) { t.start() }
  fun <U : Boat> p(u: U) { u.sail() }
  fun <V> q(v: V) { v.sail() }
}
class Rig<T : Car> { fun <T : Boat> m(t: T) { t.sail() } }
fun <X : Boat> top(x: X) { x.sail() }
`,
    }));
  });
  afterAll(() => done());

  it("links the class and function bounds, method first, unbounded never", () => {
    expect(targets(summary, "Garage.n", "t.start")).toEqual(["Car.start"]);
    expect(targets(summary, "Garage.p", "u.sail")).toEqual(["Boat.sail"]);
    expect(targets(summary, "Rig.m", "t.sail")).toEqual(["Boat.sail"]);
    expect(targets(summary, "Garage.q", "v.sail")).toEqual([]);
    expect(summary.symbolLinks.filter((l) => l.targetSymbol.startsWith("Decoy."))).toEqual([]);
  });
});

describe("a bounded type parameter as a Kotlin extension receiver", () => {
  it("types the implicit receiver as the bound", async () => {
    const { summary, done } = await scan({
      "Models.kt": "package com.example.league\nopen class Boat { fun sail() {} }\nclass Decoy { fun sail() {} }\n",
      "Dock.kt": "package com.example.league\nfun <T : Boat> T.dock() { this.sail() }\n",
    });
    try {
      expect(summary.symbolLinks.filter((l) => l.callName.endsWith("sail")).map((l) => l.targetSymbol)).toEqual(["Boat.sail"]);
    } finally { await done(); }
  });
});
