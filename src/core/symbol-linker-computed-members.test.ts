import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const fn = (name: string, line: number, calls: CallInfo[] = []) =>
  ({ name, line, endLine: line + 3, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });
const call = (name: string, line: number): CallInfo => ({ name, kind: "internal", target: null, line });
const prop = (name: string, type: string | null, from?: string) =>
  ({ name, type, visibility: "public", isStatic: false, isReadonly: true, ...(from ? { from } : {}) });
const klass = (name: string, extra: Record<string, unknown>) =>
  ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 40, ...extra });
const file = (filePath: string, classes: unknown[]): FileAnalysis =>
  ({ filePath, language: "python", projectId: "root", imports: [], exports: [], functions: [], classes, routes: [], dataSources: [] }) as unknown as FileAnalysis;

describe("a call through a computed member", () => {
  it("types self.repo by the chain its property returns, through another class's typed property", () => {
    const controller = file("league/routes/players.py", [klass("PlayersController", {
      extends: "BaseController",
      properties: [prop("repo", null, "self.repos.players")],
      methods: [fn("get_all", 10, [call("self.repo.page_all", 11)])],
    })]);
    const base = file("league/routes/base.py", [klass("BaseController", { properties: [prop("repos", "AllRepositories | None")] })]);
    const repos = file("league/repos/all_repositories.py", [klass("AllRepositories", { properties: [prop("players", "PlayerRepository")] })]);
    const repo = file("league/repos/players.py", [klass("PlayerRepository", { methods: [fn("page_all", 5)] })]);
    const links = buildSymbolLinks([controller, base, repos, repo]).filter((l) => l.sourceSymbol === "PlayersController.get_all");
    expect(links.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toEqual(["league/repos/players.py::PlayerRepository.page_all"]);
  });
});
