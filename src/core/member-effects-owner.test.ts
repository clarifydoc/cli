import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { buildMcpServer } from "../mcp/server.js";

/**
 * Field writes, property reads and thrown types name the writing function and the class by the owner path the links use:
 * two nested `Builder`s of one file (`Left.Builder.build`, `Right.Builder.build`) are two writers, a top-level `Builder`
 * keeps its name, and the MCP readers find each one.
 */
describe("member effects of same-named nested classes", () => {
  let dir = "";
  let summary: Record<string, any>;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-effects-owner-"));
    const root = join(dir, "repo");
    const files: Record<string, string> = {
      "Match.java": [
        "public class Match {", "  public static class Left {", "    public static class Builder {", "      private int shots;",
        "      public Builder build(int n) {", "        this.shots = n;", "        if (n < 0) throw new IllegalStateException(\"left\");", "        return this;", "      }",
        "      public int peek() { return this.shots; }", "    }", "  }",
        "  public static class Right {", "    public static class Builder {", "      private int fouls;",
        "      public Builder build(int n) {", "        this.fouls = n;", "        if (n > 9) throw new IllegalArgumentException(\"right\");", "        return this;", "      }",
        "      public int peek() { return this.fouls; }", "    }", "  }", "}",
        "class Builder {", "  int tally;", "  Builder build(int n) { this.tally = n; throw new UnsupportedOperationException(\"top\"); }", "}", "",
      ].join("\n"),
      "Match.cs": [
        "using System;", "namespace League {", "public class Match {", "  public class Left {", "    public class Builder {", "      public int Shots { get; set; }",
        "      public Builder Build(int n) {", "        this.Shots = n;", "        if (n < 0) throw new InvalidOperationException(\"left\");", "        return this;", "      }", "    }", "  }",
        "  public class Right {", "    public class Builder {", "      public int Fouls { get; set; }",
        "      public Builder Build(int n) {", "        this.Fouls = n;", "        if (n > 9) throw new ArgumentException(\"right\");", "        return this;", "      }", "    }", "  }", "}",
        "public class Builder {", "  public int Tally { get; set; }", "  public Builder Build(int n) { this.Tally = n; throw new NotSupportedException(\"top\"); }", "}", "}", "",
      ].join("\n"),
      "Squad.java": [
        "public class Squad {", "  public static class Builder {", "    public int build(int n) { return n; }", "    public int both(int k) { return build(k); }", "  }", "}",
        "class Builder {", "  public int build(int n, int m) { return n; }", "  public int both(int k) { return build(k, k); }", "}", "",
      ].join("\n"),
      "match.py": [
        "class Left:", "    class Builder:", "        def build(self, n):", "            self.shots = n", "            if n < 0:", "                raise ValueError('left')", "            return self", "",
        "class Right:", "    class Builder:", "        def build(self, n):", "            self.fouls = n", "            if n > 9:", "                raise KeyError('right')", "            return self", "",
        "class Builder:", "    def build(self, n):", "        self.tally = n", "        raise NotImplementedError('top')", "",
      ].join("\n"),
      "match.rb": [
        "module League", "  class Left", "    class Builder", "      def build(n)", "        @shots = n", "        raise ArgumentError, 'left' if n < 0", "        self", "      end", "    end", "  end",
        "  class Right", "    class Builder", "      def build(n)", "        @fouls = n", "        raise KeyError, 'right' if n > 9", "        self", "      end", "    end", "  end", "end",
        "class Builder", "  def build(n)", "    @tally = n", "    raise RuntimeError, 'top'", "  end", "end", "",
      ].join("\n"),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = (await loadReportSummary(out)) as Record<string, any>;
    const { server } = buildMcpServer({ projectRoot: root, analysisDir: out, allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 90_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writes = (file: string) => (summary.fieldWrites as any[]).filter((w) => w.file === file).map((w) => `${w.class} ${w.member} ${w.function}`).sort();
  const throws = (file: string) => (summary.thrownTypes as any[]).filter((t) => t.file === file).map((t) => `${t.type} ${t.function}`).sort();

  it("Java: a writer and a thrower per owner path, the top-level decoy keeps its name", () => {
    expect(writes("Match.java")).toEqual([
      "Builder tally Builder.build",
      "Match.Left.Builder shots Match.Left.Builder.build",
      "Match.Right.Builder fouls Match.Right.Builder.build",
    ]);
    expect(throws("Match.java")).toEqual([
      "IllegalArgumentException Match.Right.Builder.build",
      "IllegalStateException Match.Left.Builder.build",
      "UnsupportedOperationException Builder.build",
    ]);
    expect((summary.fieldReads as any[]).filter((r) => r.file === "Match.java").map((r) => `${r.class} ${r.member} ${r.function}`).sort()).toEqual([
      "Match.Left.Builder shots Match.Left.Builder.peek",
      "Match.Right.Builder fouls Match.Right.Builder.peek",
    ]);
  });

  it("C#: the same", () => {
    expect(writes("Match.cs")).toEqual(["Builder Tally Builder.Build", "Match.Left.Builder Shots Match.Left.Builder.Build", "Match.Right.Builder Fouls Match.Right.Builder.Build"]);
    expect(throws("Match.cs")).toContain("InvalidOperationException Match.Left.Builder.Build");
  });

  it("Python: the same", () => {
    expect(writes("match.py")).toEqual(["Builder tally Builder.build", "Left.Builder shots Left.Builder.build", "Right.Builder fouls Right.Builder.build"]);
    expect(throws("match.py")).toEqual(["KeyError Right.Builder.build", "NotImplementedError Builder.build", "ValueError Left.Builder.build"]);
  });

  it("Ruby: modules own the classes", () => {
    expect(writes("match.rb")).toEqual(["Builder tally Builder.build", "League.Left.Builder shots League.Left.Builder.build", "League.Right.Builder fouls League.Right.Builder.build"]);
  });

  it("the function ids are the ones the symbol links use", () => {
    const targets = new Set((summary.symbolLinks as any[] | undefined ?? []).map((l) => `${l.targetFile}::${l.targetSymbol}`));
    const complexity = new Set((summary.complexity as any[]).flatMap((c) => c.functions.map((f: any) => `${c.filePath}::${f.functionName}`)));
    for (const w of summary.fieldWrites as any[]) if (w.file === "Match.java") expect(complexity.has(`${w.file}::${w.function}`) || targets.has(`${w.file}::${w.function}`)).toBe(true);
  });

  it("a signature carries the id the link ends at", () => {
    const linkTargets = (summary.symbolLinks as any[]).filter((l) => l.targetFile === "Squad.java").map((l) => l.targetSymbol);
    expect(linkTargets).toContain("Squad.Builder.build");
    const signed = (summary.symbolSignatures as any[]).filter((g) => g.file === "Squad.java").map((g) => g.symbol);
    expect(signed).toContain("Squad.Builder.build");
    // the top-level decoy is linked to as well and keeps its own row and name
    expect(signed).toContain("Builder.build");
  });

  it("trace writers finds one nested class by its path and by its leaf", async () => {
    const left = await call("clarifydoc_trace", { symbol: "Match.Left.Builder.shots", direction: "writers", file: "Match.java" });
    expect(left).toContain("Match.Left.Builder.build — Match.java:6");
    expect(left).not.toContain("Right");
    const leaf = await call("clarifydoc_trace", { symbol: "Builder.fouls", direction: "writers", file: "Match.java" });
    expect(leaf).toContain("Match.Right.Builder.build — Match.java:17");
    const top = await call("clarifydoc_trace", { symbol: "Builder.tally", direction: "writers", file: "Match.java" });
    expect(top).toContain("- Builder.build — Match.java:27");
  });

  it("trace readers and explain still find the nested function", async () => {
    const readers = await call("clarifydoc_trace", { symbol: "Match.Right.Builder.fouls", direction: "readers", file: "Match.java" });
    expect(readers).toContain("Match.Right.Builder.peek — Match.java:21");
    const explained = await call("clarifydoc_explain", { subject: "Match.Left.Builder.build", file: "Match.java" });
    expect(explained).toContain("IllegalStateException");
    expect(explained).not.toContain("IllegalArgumentException");
  });
});
