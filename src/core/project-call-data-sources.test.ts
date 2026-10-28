import { describe, it, expect } from "vitest";
import { demoteProjectCallDataSources } from "./project-call-data-sources.js";
import type { DataSourceInfo, FileAnalysis, SymbolLink } from "../types/analysis.js";

const ds = (name: string, line: number): DataSourceInfo =>
  ({ kind: "database", name, target: null, calls: [], line, access: "write" }) as DataSourceInfo;

const file = (filePath: string, over: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, functions: [], classes: [], dataSources: [], ...over }) as unknown as FileAnalysis;

const link = (from: string, line: number, callName: string, to: string, symbol: string, over: Partial<SymbolLink> = {}): SymbolLink => ({
  sourceFile: from, sourceSymbol: "caller", sourceLine: line, callName,
  targetFile: to, targetSymbol: symbol, targetLine: 1,
  confidence: "EXTRACTED", strategy: "deep-qualified", ...over,
});

const names = (a: FileAnalysis) => a.dataSources.map((d) => d.name);

describe("demoteProjectCallDataSources", () => {
  it("drops a DB data source whose call resolves into the project's own code", () => {
    // A demo app: `agent.Comments.create(…)` in a browser component is a call
    // into the frontend's HTTP client, not a write to a `Comments` table.
    const page = file("web/CommentInput.js", { dataSources: [ds("agent.Comments.create", 24), ds("prisma.comment.create", 30)] });
    const agent = file("web/agent.js");
    const n = demoteProjectCallDataSources([page, agent], [link("web/CommentInput.js", 24, "agent.Comments.create", "web/agent.js", "Comments.create")]);
    expect(n).toBe(1);
    expect(names(page)).toEqual(["prisma.comment.create"]);
  });

  it("keeps it when the evidence is a heuristic, or the site does not match", () => {
    const mk = () => file("a.ts", { dataSources: [ds("repo.save", 5)] });
    for (const over of [{ confidence: "AMBIGUOUS" as const }, { strategy: "unique-global-blind" as const }, { strategy: "factory-via" as const }]) {
      const a = mk();
      demoteProjectCallDataSources([a, file("b.ts")], [link("a.ts", 5, "repo.save", "b.ts", "Repo.save", over)]);
      expect(names(a)).toEqual(["repo.save"]);
    }
    const a = mk();
    demoteProjectCallDataSources([a, file("b.ts")], [link("a.ts", 6, "repo.save", "b.ts", "Repo.save")]);
    expect(names(a)).toEqual(["repo.save"]);
  });

  it("keeps a call into an ORM entity's method or an interface method — that is where the query is", () => {
    const svc = file("svc.rb", { dataSources: [ds("Player.active", 3), ds("players.findByEmail", 9)] });
    const model = file("player.rb", { classes: [{ name: "Player", decorators: ["ApplicationRecord", "entity", "activerecord"], methods: [] }] as any });
    const repo = file("PlayerRepository.java", { classes: [{ name: "PlayerRepository", kind: "interface", decorators: [], methods: [] }] as any });
    const n = demoteProjectCallDataSources([svc, model, repo], [
      link("svc.rb", 3, "Player.active", "player.rb", "Player.active", { strategy: "class-name" }),
      link("svc.rb", 9, "players.findByEmail", "PlayerRepository.java", "PlayerRepository.findByEmail", { strategy: "injection" }),
    ]);
    expect(n).toBe(0);
    expect(names(svc)).toEqual(["Player.active", "players.findByEmail"]);
  });

  it("drops a db-write mutation made by a call into a project class, keeping one into an entity", () => {
    const coach = file("Coach.java", {
      dataMutations: [
        { kind: "db-write", target: "ClubStore.save(club)", value: null, line: 5 },
        { kind: "db-write", target: "Player.save(p)", value: null, line: 6 },
        { kind: "db-write", target: "jdbc.update(sql)", value: null, line: 7 },
      ],
    });
    const store = file("ClubStore.java", { classes: [{ name: "ClubStore", decorators: [], methods: [] }] as any });
    const player = file("Player.java", { classes: [{ name: "Player", decorators: ["entity"], methods: [] }] as any });
    const n = demoteProjectCallDataSources([coach, store, player], [
      link("Coach.java", 5, "ClubStore.save", "ClubStore.java", "ClubStore.save", { strategy: "class-name", confidence: "INFERRED" }),
      link("Coach.java", 6, "Player.save", "Player.java", "Player.save", { strategy: "class-name", confidence: "INFERRED" }),
    ]);
    expect(n).toBe(1);
    expect(coach.dataMutations.map((m) => m.target)).toEqual(["Player.save(p)", "jdbc.update(sql)"]);
  });
});
