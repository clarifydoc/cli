import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildSequence } from "./sequence.js";
import { sequenceReading } from "./sequence-frames.js";
import { blankSpecFor, callSitesIn } from "./sequence-order.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

const source = `export async function run(ok: boolean, repo: Repo) {
  save(build(make()));
  if (ok) { notify(); } else { cleanup(); }
  await audit();
  repo.find().load();
  try {
    await audit();
    notify();
  } catch (e) {
    cleanup();
  } finally {
    notify();
  }
  for (const m of matches) {
    score(m);
  }
  audit();
}
`;

const link = (callName: string, sourceLine: number): SymbolLink =>
  ({ sourceFile: "a.ts", sourceSymbol: "run", sourceLine, callName, targetFile: "a.ts", targetSymbol: callName, targetLine: 100, confidence: "EXTRACTED", relation: "calls" }) as SymbolLink;

describe("callSitesIn", () => {
  it("finishes an argument before the call receiving it and a chain left to right", () => {
    const names = (text: string) => callSitesIn(text.split("\n"), 1, text.split("\n").length).map((s) => s.name);
    expect(names("save(build(make()));")).toEqual(["make", "build", "save"]);
    expect(names("repo.find(id).load(x).map(y);")).toEqual(["find", "load", "map"]);
    expect(names('log("save(x)"); // build()\nlater(a(\n  b()\n));')).toEqual(["log", "b", "a", "later"]);
  });

  it("reads no call inside a string or a comment, in the language's own syntax", () => {
    const names = (text: string, language: string) => callSitesIn(text.split("\n"), 1, text.split("\n").length, blankSpecFor(language)).map((s) => s.name);
    expect(names('log("save(x)")', "typescript")).toEqual(["log"]);
    expect(names("run()  # audit() later\nstop()", "python")).toEqual(["run", "stop"]);
    expect(names("run()  // audit()\nstop()", "typescript")).toEqual(["run", "stop"]);
    expect(names("puts(1) # audit()", "ruby")).toEqual(["puts"]);
  });

  it("marks only the call an await introduces", () => {
    const awaited = (text: string) => callSitesIn([text], 1, 1).filter((s) => s.awaited).map((s) => s.name);
    expect(awaited("await audit();")).toEqual(["audit"]);
    expect(awaited("const x = await repo.find().load();")).toEqual(["load"]);
    expect(awaited("save(await build());")).toEqual(["build"]);
    expect(awaited("audit();")).toEqual([]);
    expect(awaited("let r = fetch(url).await;")).toEqual(["fetch"]);
  });
});

describe("buildSequence in run order", () => {
  it("draws the calls as the body runs them, every site, await, try sections and a one-line alt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-order-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a.ts"), source);
      const { frames, sources } = await sequenceReading(dir, ["a.ts"]);
      const names = ["make", "build", "save", "notify", "cleanup", "audit", "find", "load", "score"];
      const lines = [2, 2, 2, 3, 3, 4, 5, 5, 15];
      const summary = { symbolLinks: names.map((n, i) => link(n, lines[i]!)), symbolDataAccess: [] } as unknown as ProjectAnalysis;
      const diagram = buildSequence(summary, { file: "a.ts", symbol: "run", title: "run" }, { frames, sources, fanOut: 30 });
      const body = diagram.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("participant") && !l.startsWith("sequenceDiagram") && !l.startsWith("title"));
      const m = (name: string, prefix = "") => `a_ts->>a_ts: ${prefix}${name}()`;
      expect(body).toEqual([
        "Client->>a_ts: run",
        m("make"), m("build"), m("save"),
        "alt (ok)", m("notify"), "else", m("cleanup"), "end",
        m("audit", "await "),
        m("find"), m("load"),
        "critical try", m("audit", "await "), m("notify"), "option catch e", m("cleanup"), "option finally", m("notify"), "end",
        "loop for (const m of matches)", m("score"), "end",
        m("audit"),
        "a_ts-->>Client: response",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the old order without the source", () => {
    const summary = { symbolLinks: [link("two", 5), link("one", 5)], symbolDataAccess: [] } as unknown as ProjectAnalysis;
    const text = buildSequence(summary, { file: "a.ts", symbol: "run", title: "run" });
    expect(text.indexOf("one()")).toBeLessThan(text.indexOf("two()"));
  });
});
