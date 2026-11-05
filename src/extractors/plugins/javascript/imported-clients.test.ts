import { describe, it, expect } from "vitest";
import { confirmImportedClients } from "./imported-clients.js";
import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

const file = (filePath: string, parts: Partial<FileAnalysis>): FileAnalysis =>
  ({ filePath, language: "typescript", imports: [], exports: [], functions: [], classes: [], dataSources: [], ...parts }) as unknown as FileAnalysis;

const row = (client: string, target: string, line: number): DataSourceInfo => ({ kind: "api-call", name: "post", target, client, line, calls: [], clientUnconfirmed: true });

describe("confirmImportedClients", () => {
  it("keeps a request on an imported client instance (renamed or default) and drops one on any other import", () => {
    const caller = file("src/api/clubs.ts", {
      imports: [
        { source: "./http", specifiers: ["clubHttp"], aliases: { clubHttp: "http" }, isDefault: false, isNamespace: false, isType: false, line: 1 },
        { source: "./league", specifiers: ["league"], isDefault: true, isNamespace: false, isType: false, line: 2 },
        { source: "./store", specifiers: ["store"], isDefault: true, isNamespace: false, isType: false, line: 3 },
      ],
      dataSources: [row("clubHttp", "clubs/transfer", 5), row("league", "fixtures", 6), row("store", "drafts/save", 7)],
    });
    const http = file("src/api/http.ts", {
      exports: [{ name: "http", kind: "variable", line: 2 }],
      functions: [{ name: "<setup>", localTypes: [{ name: "http", type: "", from: "ky.create()" }] } as unknown as FileAnalysis["functions"][number]],
    });
    const league = file("src/api/league.ts", {
      exports: [{ name: "default", kind: "default", line: 4, sourceName: "leagueClient" }],
      httpClientRegistrations: [{ client: "leagueClient", scope: "file", base: { kind: "env", key: "LEAGUE_URL" }, line: 2 }],
    });
    const store = file("src/api/store.ts", {
      exports: [{ name: "default", kind: "default", line: 3, sourceName: "store" }],
      functions: [{ name: "<setup>", localTypes: [{ name: "store", type: "", from: "createStore()" }] } as unknown as FileAnalysis["functions"][number]],
    });
    const files = [caller, http, league, store];
    const sources: Record<string, string> = { clubHttp: http.filePath, league: league.filePath, store: store.filePath };
    const ctx = {
      importIndex: { localFor: (_f: string, name: string) => sources[name] ?? null },
      fileOf: (p: string) => files.find((f) => f.filePath === p),
    } as unknown as ProjectContext;
    const calls: ProjectApiCall[] = caller.dataSources.map((d) => ({ ...d, filePath: caller.filePath }));

    expect(confirmImportedClients(calls, ctx)).toBe(2);
    expect(calls.map((c) => [c.client, c.target, c.clientUnconfirmed])).toEqual([
      ["clubHttp", "clubs/transfer", undefined],
      ["league", "fixtures", undefined],
    ]);
    expect(caller.dataSources.map((d) => [d.client, d.clientUnconfirmed])).toEqual([["clubHttp", undefined], ["league", undefined]]);
  });
});
