import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("a type parameter's constraint types the parameter written as it (C#)", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "League/Models.cs": `namespace League;
public class Car { public void Start() {} }
public class Boat { public void Sail() {} }
public class Decoy { public void Start() {} public void Sail() {} }
`,
    "League/Garage.cs": `namespace League;
public class Garage<T> where T : Car {
  public void N(T t) { t.Start(); }
  public void P<U>(U u) where U : Boat { u.Sail(); }
  public void Q<V>(V v) { v.Sail(); }
  public void R<W>(W w) where W : class, Boat { w.Sail(); }
  public void Local(T t) { T other = t; other.Start(); }
}
public class Rig<T> where T : Car { public void M<T>(T t) where T : Boat { t.Sail(); } }
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-bounds-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const targets = (from: string, call: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === call).map((l) => l.targetSymbol).sort();

  it("links the class constraint, the method constraint and the first type constraint", () => {
    expect(targets("Garage.N", "t.Start")).toEqual(["Car.Start"]);
    expect(targets("Garage.P", "u.Sail")).toEqual(["Boat.Sail"]);
    expect(targets("Garage.R", "w.Sail")).toEqual(["Boat.Sail"]);
    expect(targets("Garage.Local", "other.Start")).toEqual(["Car.Start"]);
  });
  it("prefers the method's own constraint; an unconstrained letter stays unlinked; the decoy is never the target", () => {
    expect(targets("Rig.M", "t.Sail")).toEqual(["Boat.Sail"]);
    expect(targets("Garage.Q", "v.Sail")).toEqual([]);
    expect(summary.symbolLinks.filter((l) => l.targetSymbol.startsWith("Decoy."))).toEqual([]);
  });
});
