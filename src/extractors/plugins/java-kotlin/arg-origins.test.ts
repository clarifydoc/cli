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

describe("argument origins and Spring Data filter fields (Java, Kotlin)", () => {
  it("reads a derived query's criteria and an annotated query's placeholders", async () => {
    const svc = await analyze(`package com.example.league;
public class ClubService {
    private final PlayerRepository playerRepository;
    public java.util.List<Player> squad(Long clubId, String season, java.time.LocalDate from) {
        return playerRepository.findByClubIdAndSeasonIgnoreCaseAndJoinedAfterAndRetiredFalseOrderByNameAsc(clubId, season, from);
    }
    public long count(Long clubId) {
        return playerRepository.countByClubId(Long.valueOf(clubId));
    }
}`, "src/main/java/com/example/league/ClubService.java", "java");
    expect(filters(svc)).toEqual([
      [5, [{ field: "clubId", origin: { kind: "param", name: "clubId", index: 0 } }, { field: "season", origin: { kind: "param", name: "season", index: 1 } }]],
      [8, [{ field: "clubId", origin: { kind: "param", name: "clubId", index: 0 }, transform: "Long.valueOf" }]],
    ]);
    const repo = await analyze(`package com.example.league;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
public interface ClubRepository extends JpaRepository<Club, Long> {
    @Query("select c from Club c where c.slug = :slug and c.league.id = ?2")
    Club findOne(@Param("slug") String clubSlug, Long leagueId);
}`, "src/main/java/com/example/league/ClubRepository.java", "java");
    expect(filters(repo)).toEqual([
      [6, [{ field: "slug", origin: { kind: "param", name: "clubSlug", index: 0 } }, { field: "league.id", origin: { kind: "param", name: "leagueId", index: 1 } }]],
    ]);
  });

  it("reads Kotlin named arguments by name", async () => {
    const a = await analyze(`package com.example.league
class MatchController(private val matches: MatchService) {
    fun one(matchId: Long) = matches.find(id = matchId, "home")
}`, "src/main/kotlin/com/example/league/MatchController.kt", "kotlin");
    expect(callOf(a, "MatchController.one", "matches.find")?.argOrigins).toEqual([
      { index: 0, param: "id", origin: { kind: "param", name: "matchId", index: 0 } },
      { index: 1, origin: { kind: "literal", value: "home" } },
    ]);
  });

  it("names a route parameter as the request does, and the handler's own variable beside it", async () => {
    const a = await analyze(`package com.example.league;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/clubs")
public class ClubController {
    @GetMapping("/{id}/players")
    public Object players(@PathVariable("id") Long clubId, @RequestParam(value = "season", required = false) String s, @RequestParam String sort) {
        return null;
    }
}`, "src/main/java/com/example/league/ClubController.java", "java");
    expect(a.routes[0]!.params).toEqual([
      { name: "id", type: "Long", binding: "route", variable: "clubId" },
      { name: "season", type: "String", binding: "query", variable: "s" },
      { name: "sort", type: "String", binding: "query" },
    ]);
  });
});
