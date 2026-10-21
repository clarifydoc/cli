import { describe, it, expect } from "vitest";
import { buildIndex, withStdoutProtected } from "./store.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * The stdout guard is the one thing that cannot regress quietly: the analyzer
 * draws an in-place progress line with a bare `process.stdout.write`, and on an
 * MCP session that lands inside a JSON-RPC frame and silently kills the
 * response it collides with.
 */
describe("withStdoutProtected", () => {
  it("keeps console output and raw stdout writes off the wire", async () => {
    const logged: string[] = [];
    const escaped: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    // Watch the descriptor from outside the guard: anything the task manages to
    // push through lands here.
    process.stdout.write = ((chunk: unknown): boolean => {
      escaped.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await withStdoutProtected((m) => logged.push(m), async () => {
        console.log("analyzer chatter");
        console.warn("a warning");
        process.stdout.write("\rAnalyzing [3/9] src/app.ts");
        return "done";
      });
      expect(result).toBe("done");
      expect(escaped).toEqual([]);
      expect(logged.join("\n")).toContain("analyzer chatter");
      expect(logged.join("\n")).toContain("a warning");
    } finally {
      process.stdout.write = realWrite;
    }
  });

  it("restores console and stdout even when the task throws", async () => {
    const before = { log: console.log, write: process.stdout.write };
    await expect(
      withStdoutProtected(
        () => {},
        async () => {
          throw new Error("analysis blew up");
        },
      ),
    ).rejects.toThrow("analysis blew up");
    expect(console.log).toBe(before.log);
    expect(process.stdout.write).toBe(before.write);
  });

  it("invokes the write callback in both argument shapes", async () => {
    const calls: string[] = [];
    await withStdoutProtected(
      () => {},
      async () => {
        process.stdout.write("a", () => calls.push("encoding-position"));
        process.stdout.write("b", "utf8", () => calls.push("callback-position"));
      },
    );
    expect(calls).toEqual(["encoding-position", "callback-position"]);
  });
});

describe("buildIndex", () => {
  const summary = {
    projectRoot: "C:/proj",
    files: ["src/a.ts", "src/b.ts"],
    detectedFrameworks: [],
    subProjects: [],
    fileProjects: { "src/a.ts": "root" },
    componentGraph: {},
    linkGraph: [],
    interactiveElements: [],
    events: [],
    routeMap: [{ path: "/x", httpMethod: "GET", kind: "api", handler: "h", calls: [], middleware: [], line: 4, filePath: "src/a.ts" }],
    apiCalls: [],
    screens: [],
    symbolLinks: [
      {
        sourceFile: "src/a.ts",
        sourceSymbol: "callerFn",
        sourceLine: 10,
        callName: "target",
        targetFile: "src/b.ts",
        targetSymbol: "target",
        targetLine: 2,
      },
    ],
    analyzedAt: "2026-01-01T00:00:00.000Z",
    fileLayerMap: { "src/a.ts": "services" },
    entityGraph: {
      nodes: [
        { id: "src/b.ts::Player", name: "Player", orm: "prisma", kind: "entity", filePath: "src/b.ts", columns: [], line: 1 },
      ],
      edges: [],
    },
    symbolReach: [
      { file: "src/a.ts", symbol: "callerFn", effects: [], effectCounts: { db: 2 }, hasTransitive: true },
    ],
  } as unknown as ProjectAnalysis;

  it("groups links from both ends, and layers, routes and entities by name", () => {
    const index = buildIndex(summary);
    expect(index.byFile.get("src/a.ts")?.outbound).toHaveLength(1);
    expect(index.byFile.get("src/b.ts")?.inbound).toHaveLength(1);
    expect(index.byFile.get("src/a.ts")?.routes[0].path).toBe("/x");
    expect(index.byFile.get("src/a.ts")?.layer).toBe("services");
    expect(index.entitiesByName.get("player")?.[0].id).toBe("src/b.ts::Player");
    expect(index.reachBySymbol.get("src/a.ts::callerfn")?.effectCounts.db).toBe(2);
  });

  it("gives every analyzed file an entry, even one with no facts", () => {
    const index = buildIndex(summary);
    expect([...index.byFile.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(index.pathLookup.get("src/b.ts")).toBe("src/b.ts");
  });
});
