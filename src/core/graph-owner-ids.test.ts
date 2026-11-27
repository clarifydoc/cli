import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { buildEntityGraph } from "./entity-graph.js";
import { inheritanceIndex, relatives } from "./overrides.js";
import type { ClassGraph, ClassInfo, FileAnalysis } from "../types/analysis.js";

/**
 * A class graph node and an entity graph node of a nested or function-local type carry its owner path in the id,
 * `${file}::Left.Builder`, the one spelling `symbolLinks` uses; a top-level type keeps `${file}::Builder`, and the
 * label (`name`) keeps the source's spelling. Two nested namesakes are two nodes, each with its own edges.
 */
describe("class graph ids of nested namesakes (end to end)", () => {
  let dir = "";
  let summary: Record<string, any>;
  const files: Record<string, string> = {
    "Match.java": [
      "class Club {}", "class Player {}", "",
      "class Left {", "    static class Builder {", "        Club club;", "    }", "}", "",
      "class Right {", "    static class Builder {", "        Player player;", "    }", "}", "",
      "class Builder {", "    Left left;", "}", "",
    ].join("\n"),
    "N.cs": [
      "namespace Example.League", "{", "    public class Club {}", "    public class Player {}",
      "    public class Left", "    {", "        public class Builder", "        {", "            private Club club;", "        }", "    }",
      "    public class Right", "    {", "        public class Builder", "        {", "            private Player player;", "        }", "    }",
      "    public class Builder { private Left left; }", "}", "",
    ].join("\n"),
    "n.ts": [
      "export class Club {}", "export class Player {}",
      "export namespace Left {", "  export class Builder { club: Club; }", "}",
      "export namespace Right {", "  export class Builder { player: Player; }", "}", "",
    ].join("\n"),
    "n.py": [
      "class Club: pass", "class Player: pass",
      "class Left:", "    class Builder:", "        club: Club", "        def build(self) -> Club: ...", "",
      "class Right:", "    class Builder:", "        player: Player", "        def build(self) -> Player: ...", "",
      "class Builder:", "    left: Left", "",
    ].join("\n"),
    "n.rb": [
      "class Club; end", "class Player; end",
      "module Left", "  class Builder", "    def build; Club.new; end", "  end", "end",
      "module Right", "  class Builder", "    def build; Player.new; end", "  end", "end", "",
    ].join("\n"),
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-graph-ids-"));
    const root = join(dir, "repo");
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = (await loadReportSummary(join(dir, "out"))) as Record<string, any>;
  }, 60_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const graph = (): ClassGraph => summary.classGraph as ClassGraph;
  const edgesOf = (path: string): string[] =>
    graph().edges.filter((e) => e.source.startsWith(`${path}::`)).map((e) => `${e.source.slice(path.length + 2)} -> ${e.target.slice(path.length + 2)}`).sort();

  it.each([
    ["Match.java", "Left.Builder -> Club", "Right.Builder -> Player"],
    ["N.cs", "Left.Builder -> Club", "Right.Builder -> Player"],
    ["n.ts", "Left.Builder -> Club", "Right.Builder -> Player"],
    ["n.py", "Left.Builder -> Club", "Right.Builder -> Player"],
  ])("%s: two nested Builders are two nodes with their own edges, the top-level one keeps its id", (path, left, right) => {
    const ids = graph().nodes.filter((n) => n.filePath === path && n.name === "Builder").map((n) => n.id.slice(path.length + 2)).sort();
    expect(ids).toContain("Left.Builder");
    expect(ids).toContain("Right.Builder");
    const edges = edgesOf(path);
    expect(edges).toContain(left);
    expect(edges).toContain(right);
    // The edges are not shared between the namesakes.
    expect(edges).not.toContain("Left.Builder -> Player");
    expect(edges).not.toContain("Right.Builder -> Club");
    if (path !== "n.ts") {
      expect(ids).toContain("Builder");
      expect(edges.filter((e) => e.startsWith("Builder -> "))).toEqual(["Builder -> Left"]);
    }
  });

  it("keeps the label as the source writes it and every top-level id unchanged", () => {
    const n = graph().nodes.find((x) => x.id === "Match.java::Right.Builder")!;
    expect(n.name).toBe("Builder");
    expect(graph().nodes.some((x) => x.id === "Match.java::Club")).toBe(true);
    expect(graph().nodes.some((x) => x.id === "Match.java::Left")).toBe(true);
  });

  it("Ruby: a module is an owner, and the nested classes are told apart", () => {
    const ids = graph().nodes.filter((n) => n.filePath === "n.rb").map((n) => n.id.slice("n.rb::".length));
    expect(ids).toContain("Left.Builder");
    expect(ids).toContain("Right.Builder");
    expect(ids).not.toContain("Builder");
  });
});

describe("nested namesakes in sibling files stay apart (end to end)", () => {
  it("keeps ClubPolicy.Scope and MatchPolicy.Scope in their own files, each with its own edge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-graph-ids-split-"));
    try {
      const root = join(dir, "repo");
      await mkdir(join(root, "policies"), { recursive: true });
      await writeFile(join(root, "club.rb"), "class Club; end\nclass Player; end\n");
      await writeFile(join(root, "policies/club_policy.rb"), ["class ClubPolicy", "  class Scope", "    def resolve; Club.new; end", "  end", "end", ""].join("\n"));
      await writeFile(join(root, "policies/match_policy.rb"), ["class MatchPolicy", "  class Scope", "    def resolve; Player.new; end", "  end", "end", ""].join("\n"));
      await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
      const g = ((await loadReportSummary(join(dir, "out"))) as Record<string, any>).classGraph as ClassGraph;
      const scopes = g.nodes.filter((n) => n.name === "Scope").map((n) => n.id).sort();
      expect(scopes).toEqual(["policies/club_policy.rb::ClubPolicy.Scope", "policies/match_policy.rb::MatchPolicy.Scope"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("entity graph ids of nested namesakes", () => {
  const entity = (name: string, line: number, endLine: number): ClassInfo =>
    ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [{ name: "id", type: "Long", primaryKey: true }], decorators: ["entity", "jpa"], isExported: true, line, endLine }) as unknown as ClassInfo;
  const container = (name: string, line: number, endLine: number): ClassInfo =>
    ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], decorators: [], isExported: true, line, endLine }) as unknown as ClassInfo;
  const file = {
    filePath: "Rows.java", language: "java", projectId: "root", imports: [], exports: [], functions: [], routes: [], dataSources: [], complexities: [],
    classes: [
      container("Left", 1, 8), entity("Row", 2, 7),
      container("Right", 9, 16), entity("Row", 10, 15),
      entity("Row", 17, 20), entity("Club", 21, 22),
    ],
    entityRelations: [{ fromEntity: "Row", fromField: "club", toEntity: "Club", cardinality: "many-to-one", orm: "jpa" }],
  } as unknown as FileAnalysis;

  it("gives each nested entity its owner path, and keeps the top-level one", () => {
    const g = buildEntityGraph([file]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["Rows.java::Club", "Rows.java::Left.Row", "Rows.java::Right.Row", "Rows.java::Row"]);
    expect(g.nodes.every((n) => n.name === (n.id.endsWith("Club") ? "Club" : "Row"))).toBe(true);
  });

  it("joins a relation that names its source by a namesake to the top-level one, never to a guess", () => {
    const g = buildEntityGraph([file]);
    expect(g.edges.map((e) => [e.source, e.target].sort().join(" <> "))).toEqual(["Rows.java::Club <> Rows.java::Row"]);
  });
});

describe("overrides read the class graph's nested ids", () => {
  it("finds the nested subclass by its owner path and the class declaring the method", async () => {
    const graph: ClassGraph = {
      nodes: ["Left.Base", "Left.Builder"].map((s) => ({ id: `A.java::${s}`, name: s.split(".")[1]!, filePath: "A.java", isInterface: false, isExternal: false, isFile: false, inboundCount: 0, outboundCount: 0 })),
      edges: [{ source: "A.java::Left.Builder", target: "A.java::Left.Base", byKind: { extends: 1 }, total: 1, category: "inheritance" }],
    };
    const a = {
      filePath: "A.java", language: "java", functions: [], complexities: [], imports: [], exports: [], routes: [], dataSources: [],
      classes: [
        { name: "Left", kind: "class", methods: [], properties: [], decorators: [], line: 1, endLine: 10 },
        { name: "Base", kind: "class", methods: [], properties: [], decorators: [], line: 2, endLine: 4 },
        { name: "Builder", kind: "class", methods: [], properties: [], decorators: [], line: 5, endLine: 9 },
      ],
    } as unknown as FileAnalysis;
    const rows = await relatives(inheritanceIndex(graph), "A.java", "Left.Builder", "up", async () => a);
    expect(rows).toEqual([{ file: "A.java", symbol: "Left.Base", line: 2, depth: 1 }]);
  });
});
