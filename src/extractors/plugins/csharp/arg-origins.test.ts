import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis, FunctionInfo, Language } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel: string, language: Language): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "origins-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "origins-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const fns = (a: FileAnalysis): FunctionInfo[] => [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
const callOf = (a: FileAnalysis, fn: string, call: string) => fns(a).find((f) => f.name === fn)?.calls.find((c) => c.name === call);
const filters = (a: FileAnalysis) => a.dataSources.filter((d) => d.kind === "database" && d.whereFields).map((d) => [d.line, d.whereFields]);

describe("argument origins and EF filter fields (C#)", () => {
  it("reads parameters by position and by name, and the predicates of a LINQ chain", async () => {
    const a = await analyze(`using Microsoft.EntityFrameworkCore;
public class ClubRepository {
    public async Task<Club?> GetClub(int clubId, string season, IList<int> ids) {
        return await _context.Clubs
            .Where(c => c.Id == clubId && c.League.Season == season && c.Active == true)
            .Include(c => c.Players)
            .FirstOrDefaultAsync(c => ids.Contains(c.Id));
    }
    public Task<int> CountPlayers(int clubId) {
        var query = _context.Players.Where(p => p.ClubId == clubId);
        return query.Join(_context.Matches, p => p.Id, m => m.PlayerId, (p, m) => m).Where(m => m.Id == clubId).CountAsync();
    }
    public Task<Club?> Show(int id) => _service.Find(clubId: id, int.Parse(Request.Query["season"]));
}`, "Data/ClubRepository.cs", "csharp");
    expect(filters(a)).toEqual([
      [4, [
        { field: "Id", origin: { kind: "param", name: "ids", index: 2 } },
        { field: "Id", origin: { kind: "param", name: "clubId", index: 0 } },
        { field: "League.Season", origin: { kind: "param", name: "season", index: 1 } },
      ]],
      // The local's own statement; the predicate after the join sees the joined rows, so it is no filter of the set.
      [10, [{ field: "ClubId", origin: { kind: "param", name: "clubId", index: 0 } }]],
    ]);
    expect(callOf(a, "ClubRepository.Show", "_service.Find")?.argOrigins).toEqual([
      { index: 0, param: "clubId", origin: { kind: "param", name: "id", index: 0 } },
      { index: 1, origin: { kind: "query-param", name: "season" }, transform: "int.Parse" },
    ]);
  });
});
