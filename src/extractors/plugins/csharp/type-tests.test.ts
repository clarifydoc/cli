import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("C# receivers narrowed by a type test", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "League.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    "Models.cs": `namespace Example.League;
public class Club { public void Rank() {} public void Sign() {} }
public class Car { public void Rank() {} public void Sign() {} }
`,
    "Use.cs": `namespace Example.League;
public class Use {
  public void Narrow(object x) {
    if (x is Club) { x.Rank(); }
    x.Sign();
  }
  public void Guard(object x) {
    if (x is not Club) return;
    x.Sign();
  }
  public void Negated(object x) {
    if (!(x is Car)) { x.Park(); } else { x.Rank(); }
  }
  public void Both(object x, bool ok) {
    if (ok && x is Club c) { x.Sign(); }
  }
  public void Rebound(object x) {
    if (x is Club) { x = Pick(); x.Rank(); }
  }
  public void Callback(object x) {
    if (x is Club) { Later(() => x.Sign()); }
  }
  object Pick() => null;
  void Later(System.Action a) {}
}
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cs-is-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol.endsWith(from) && l.callName === callName).map((l) => l.targetSymbol);

  it("types a call in the true branch, and only there", () => {
    expect(target("Use.Narrow", "x.Rank")).toEqual(["Club.Rank"]);
    expect(target("Use.Narrow", "x.Sign")).toEqual([]);
  });
  it("types what follows an early exit, the else of a negated test and a conjunction", () => {
    expect(target("Use.Guard", "x.Sign")).toEqual(["Club.Sign"]);
    expect(target("Use.Negated", "x.Rank")).toEqual(["Car.Rank"]);
    expect(target("Use.Both", "x.Sign")).toEqual(["Club.Sign"]);
  });
  it("types nothing after a rebind or inside a lambda", () => {
    expect(target("Use.Rebound", "x.Rank")).toEqual([]);
    expect(target("Use.Callback", "x.Sign")).toEqual([]);
  });
});
