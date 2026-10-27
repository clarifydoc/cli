import { describe, it, expect } from "vitest";
import { dropCollectionLookups } from "./collection-lookups.js";
import { createEmptyAnalysis, type DataSourceInfo, type FileAnalysis, type FunctionInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

const fn = (name: string, extra: Partial<FunctionInfo> = {}): FunctionInfo => ({
  name, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 1, endLine: 1, ...extra,
});
const get = (client: string, target: string, line: number): DataSourceInfo => ({ kind: "api-call", name: "get", target, line, client, calls: [] } as DataSourceInfo);

describe("dropCollectionLookups", () => {
  it("drops a verb call on a local holding the Map another file's function returns (real-repo FP)", () => {
    const labels = createEmptyAnalysis("src/labels.ts", "typescript");
    labels.functions = [fn("distinctLabels", { returnType: "Map<string, string>" }), fn("loadClubs", { returnType: "Promise<Club[]>" })];
    const table = createEmptyAnalysis("src/league-table.ts", "typescript");
    table.functions = [fn("render", {
      line: 3, endLine: 9,
      localTypes: [{ name: "short", type: "", from: "distinctLabels()" }, { name: "clubs", type: "", from: "loadClubs()" }],
    })];
    table.dataSources = [get("short", "/sitemap-clubs.xml", 5), get("clubs", "/api/v2/clubs", 6), get("api", "/api/v2/matches", 7)];
    const files = new Map<string, FileAnalysis>([[labels.filePath, labels], [table.filePath, table]]);
    const ctx = {
      importIndex: { localFor: (_f: string, name: string) => (name === "distinctLabels" || name === "loadClubs" ? labels.filePath : null) },
      fileOf: (p: string) => files.get(p),
    } as unknown as ProjectContext;
    const calls = table.dataSources.map((d) => ({ ...d, filePath: table.filePath }));
    expect(dropCollectionLookups(calls, ctx)).toBe(1);
    expect(calls.map((c) => c.target)).toEqual(["/api/v2/clubs", "/api/v2/matches"]);
    expect(table.dataSources.map((c) => c.target)).toEqual(["/api/v2/clubs", "/api/v2/matches"]);
  });
});
