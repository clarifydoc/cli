import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "league/clubs.py"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "py-origins-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "python" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "py-origins-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const fns = (a: FileAnalysis): FunctionInfo[] => [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
const callOf = (a: FileAnalysis, fn: string, call: string) => fns(a).find((f) => f.name === fn)?.calls.find((c) => c.name === call);

describe("argument origins (Python)", () => {
  it("reads parameters by position and by keyword, request values and literals", async () => {
    const a = await analyze(`from flask import request

def show_club(club_id, season=None):
    league = request.args.get("league")
    return repo.find_club(int(club_id), league, season=season, kind="senior")

class SquadView(View):
    def get(self, request, *args, **kwargs):
        return repo.squad(self.kwargs["pk"], request.GET["sort"])
`);
    expect(callOf(a, "show_club", "repo.find_club")?.argOrigins).toEqual([
      { index: 0, origin: { kind: "param", name: "club_id", index: 0 }, transform: "int" },
      { index: 1, origin: { kind: "query-param", name: "league" } },
      { index: 2, param: "season", origin: { kind: "param", name: "season", index: 1 } },
      { index: 3, param: "kind", origin: { kind: "literal", value: "senior" } },
    ]);
    expect(callOf(a, "SquadView.get", "repo.squad")?.argOrigins).toEqual([
      { index: 0, origin: { kind: "route-param", name: "pk" } },
      { index: 1, origin: { kind: "query-param", name: "sort" } },
    ]);
  });
});

describe("Python ORM filter fields (whereFields)", () => {
  it("reads SQLAlchemy comparisons, filter_by keywords and Django lookups — through a statement local too", async () => {
    const a = await analyze(`from sqlalchemy import select
from .models import Club, Player

class ClubRepo:
    def by_slug(self, slug: str):
        stmt = select(Club).where(Club.slug == slug, Club.active == True)
        stmt = stmt.filter(Club.season == self.season)
        return self.session.execute(stmt).scalars().one_or_none()

    def players(self, club_id, ids):
        return self.session.query(Player).filter(Player.club_id == club_id, Player.id.in_(ids)).all()

def by_name(name):
    return db.session.query(Club).filter_by(name=name).first()

def clubs_in(country):
    return Club.objects.filter(league__country__code__iexact=country, active=True)
`);
    const rows = a.dataSources.filter((d) => d.kind === "database" && d.whereFields).map((d) => [d.line, d.whereFields]);
    expect(rows).toEqual([
      [8, [{ field: "slug", origin: { kind: "param", name: "slug", index: 0 } }]],
      [11, [{ field: "club_id", origin: { kind: "param", name: "club_id", index: 0 } }, { field: "id", origin: { kind: "param", name: "ids", index: 1 } }]],
      [14, [{ field: "name", origin: { kind: "param", name: "name", index: 0 } }]],
      [17, [{ field: "league.country.code", origin: { kind: "param", name: "country", index: 0 } }]],
    ]);
  });
});

describe("FastAPI dependencies", () => {
  it("marks a dependency the route's parameters are handed to by name", async () => {
    const a = await analyze(`from fastapi import APIRouter, Depends

router = APIRouter()

@router.get("/clubs/{slug}")
async def show(club = Depends(get_club_from_path), repo = Depends(get_repository(ClubRepo))):
    return club
`, "league/routes.py");
    expect(a.routes[0]!.calls.map((c) => [c.name, c.routeParamsByName ?? false])).toEqual([["get_club_from_path", true], ["get_repository", false]]);
  });
});
