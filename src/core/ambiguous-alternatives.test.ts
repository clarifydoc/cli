/**
 * Where the source offers several values, the links keep that: every route a chosen URL value reaches is
 * AMBIGUOUS, and so is a call held by several descriptors — never one picked, never a fact.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { linkApiCallsToRoutes } from "./route-linker.js";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { DataSourceInfo, FileAnalysis, RouteInfo } from "../types/analysis.js";

const apiCall = (target: string, alternatives?: string[], choice?: boolean): DataSourceInfo & { filePath: string } => ({
  kind: "api-call", name: "get", target, calls: [], line: 1, filePath: "web/exports.ts",
  ...(alternatives ? { targetAlternatives: alternatives } : {}),
  ...(choice ? { targetChoice: true } : {}),
});
const route = (path: string, handler: string): RouteInfo & { filePath: string } => ({
  path, httpMethod: "GET", kind: "api", handler, calls: [], middleware: [], line: 1, filePath: `srv/${handler}.ts`,
});

describe("a URL that is one of several values", () => {
  const routes = [route("/api/export/club", "club"), route("/api/export/player", "player"), route("/api/export/car", "car")];

  it("links each route the values reach, AMBIGUOUS, and none it does not name", () => {
    const links = linkApiCallsToRoutes([apiCall("/api/export/club", ["/api/export/player"], true)], routes);
    expect(links.map((l) => [l.routePath, l.confidence]).sort()).toEqual([
      ["/api/export/club", "AMBIGUOUS"],
      ["/api/export/player", "AMBIGUOUS"],
    ]);
  });

  it("one route reached out of several values is a guess, not a fact", () => {
    const links = linkApiCallsToRoutes([apiCall("/api/export/club", ["/api/export/${item.kind}"], true)], routes);
    expect(links.map((l) => [l.routePath, l.confidence])).toEqual([["/api/export/club", "INFERRED"]]);
  });

  it("a helper's branches (no choice) stay first-hit", () => {
    const links = linkApiCallsToRoutes([apiCall("/api/export/club", ["/api/export/player"])], routes);
    expect(links.map((l) => [l.routePath, l.confidence])).toEqual([["/api/export/club", "EXTRACTED"]]);
  });
});

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "alternatives-"));
  const out = await mkdtemp(join(tmpdir(), "alternatives-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false },
      verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

describe("the extractor", () => {
  it("keeps an enum member and a string ternary as the values of one choice", async () => {
    const [file] = await analyzeAll({
      "web/exports.ts": [
        "export class Exports {",
        "  start(wide: boolean, item: { kind: ExportKind }) {",
        "    const endpoint = wide ? ExportKind.Club : item.kind;",
        "    return fetch(`/api/export/${endpoint}`);",
        "  }",
        "  literal(wide: boolean) {",
        "    const ep = wide ? 'player' : 'match';",
        "    return fetch(`/api/export/${ep}`);",
        "  }",
        "}",
      ].join("\n"),
    });
    const sources = file!.dataSources.filter((d) => d.kind === "api-call");
    expect(sources.map((d) => [d.target, d.targetAlternatives, d.targetChoice])).toEqual([
      ["/api/export/${ExportKind.Club}", ["/api/export/${item.kind}"], true],
      ["/api/export/player", ["/api/export/match"], true],
    ]);
  });
});

describe("a URL a caller builds and hands to a request wrapper", () => {
  it("carries the values of a ternary in its path, never the ones in its query string", async () => {
    const [file] = await analyzeAll({
      "web/exports.ts": [
        "export class Exports {",
        "  start(wide: boolean, id: number) {",
        "    const endpoint = wide ? ExportKind.Club : 'player';",
        "    const key = wide ? 'clubId' : 'playerId';",
        "    const url = `${this.base}export/${endpoint}` + `?${key}=${id}`;",
        "    this.send(url);",
        "  }",
        "  send(url: string) { return fetch(url); }",
        "}",
      ].join("\n"),
    });
    expect(file!.pathArgCalls).toMatchObject([{ callee: "send", argAlternatives: [["${this.base}export/player?${key}=${id}"]] }]);
    expect(file!.pathArgCalls![0]!.args[0]).toBe("${this.base}export/${ExportKind.Club}?${key}=${id}");
  });
});

describe("calls held by several descriptors", () => {
  it("links each AMBIGUOUS; a key one literal holds stays INFERRED", async () => {
    const analyses = await analyzeAll({
      "web/club.service.ts": "export class ClubService {\n  syncClubs() { return 1; }\n  syncPlayers() { return 2; }\n  syncCar() { return 3; }\n}\n",
      "web/sync.component.ts": [
        "import { ClubService } from './club.service';",
        "export class SyncComponent {",
        "  constructor(private clubService: ClubService) {}",
        "  tasks = [",
        "    { name: 'clubs', api: this.clubService.syncClubs() },",
        "    { name: 'players', api: this.clubService.syncPlayers() },",
        "  ];",
        "  single = [{ name: 'x', run: this.clubService.syncCar() }];",
        "  run(task: { api: any }) { task.api.subscribe(); }",
        "  runOne(item: any) { item.run.subscribe(); }",
        "}",
      ].join("\n"),
    });
    const got = buildSymbolLinks(analyses)
      .filter((l) => l.sourceFile === "web/sync.component.ts" && l.callName.startsWith("this.clubService."))
      .map((l) => `${l.callName} ${l.confidence}`)
      .sort();
    expect(got).toEqual([
      "this.clubService.syncCar INFERRED",
      "this.clubService.syncClubs AMBIGUOUS",
      "this.clubService.syncPlayers AMBIGUOUS",
    ]);
  });
});
