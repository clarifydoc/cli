import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses, extractFunctions } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { pythonRouteExtractor } from "./routes.js";
import { fastapiInheritedGuards } from "./fastapi-guards.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import { resolveRouterMounts } from "../../shared/router-mounts.js";
import { buildImportIndex, resolveImportSource } from "../../../core/import-index.js";
import { buildClassIndex } from "../../../core/class-index.js";
import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

async function analyze(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "python" as never, filePath);
    const facts: RouteFact[] = [];
    out.push({
      filePath,
      language: "python",
      projectId: "root",
      imports: extractImports(tree, src, "python" as never),
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, "python" as never),
      functions: extractFunctions(tree, src, "python" as never),
      routes: pythonRouteExtractor.extractRoutes(tree, src, filePath, facts),
      dataSources: [],
      routeFacts: facts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const known = new Set(out.map((a) => a.filePath));
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(out, importIndex),
    resolveModule: (from, spec) => resolveImportSource(from, spec, known),
    fileOf: (p) => out.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(out, ctx, [fastapiInheritedGuards]);
  resolveRouterMounts(out, importIndex);
  return out;
}

const guards = (files: FileAnalysis[]) =>
  files
    .flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} [${(r.auth?.policies ?? []).join(",")}] ${r.middleware.join(" | ")}`))
    .sort();

const BASE = {
  "league/routes/base/routers.py": `
from fastapi import APIRouter, Depends
from league.core.deps import get_admin_user, get_current_user

class AdminRouter(APIRouter):
    def __init__(self, prefix: str = "", **kwargs):
        super().__init__(prefix=prefix, dependencies=[Depends(get_admin_user)], **kwargs)

class MemberRouter(APIRouter):
    def __init__(self, prefix: str = "", **kwargs):
        super().__init__(prefix=prefix, dependencies=[Depends(get_current_user)], **kwargs)
`,
  "league/routes/base/views.py": `
from fastapi import Depends
from league.core.deps import generate_session, get_current_user, get_admin_user, get_public_league

class BaseView:
    session = Depends(generate_session)

class PublicView(BaseView):
    league = Depends(get_public_league)

class MemberView(BaseView):
    user: User = Depends(get_current_user)

class AdminView(MemberView):
    user: User = Depends(get_admin_user)
`,
};

describe("FastAPI guards declared around a route", () => {
  it("adds the dependencies a project router class builds its router with", async () => {
    const out = await analyze({
      ...BASE,
      "league/routes/clubs.py": `
from fastapi import APIRouter
from league.routes.base.routers import MemberRouter

public_router = APIRouter(prefix="/clubs")
router = MemberRouter(prefix="/clubs")

@public_router.get("/public")
def list_public():
    pass

@router.get("/{club_id}")
def get_club(club_id: int):
    pass
`,
    });
    expect(guards(out)).toEqual([
      "GET /clubs/public [] ",
      "GET /clubs/{club_id} [get_current_user] Depends(get_current_user)",
    ]);
  });

  it("passes a guarded router's dependencies on to the routers it includes, and include_router's own", async () => {
    const out = await analyze({
      ...BASE,
      "league/routes/admin/__init__.py": `
from league.routes.base.routers import AdminRouter
from . import seasons

router = AdminRouter(prefix="/admin")
router.include_router(seasons.router)
`,
      "league/routes/admin/seasons.py": `
from fastapi import APIRouter
router = APIRouter(prefix="/seasons")

@router.delete("/{season_id}")
def delete_season(season_id: int):
    pass
`,
      "league/routes/__init__.py": `
from fastapi import APIRouter, Depends
from . import fixtures
router = APIRouter()
router.include_router(fixtures.router, dependencies=[Depends(verify_token), Depends(get_db)])
`,
      "league/routes/fixtures.py": `
from fastapi import APIRouter
router = APIRouter(prefix="/fixtures")

@router.get("")
def list_fixtures():
    pass
`,
    });
    expect(guards(out)).toEqual([
      "DELETE /admin/seasons/{season_id} [get_admin_user] Depends(get_admin_user)",
      "GET /fixtures [verify_token] Depends(verify_token)",
    ]);
  });

  it("adds a class-based view's class-level dependencies from the view and each base, a subclass shadowing its base", async () => {
    const out = await analyze({
      ...BASE,
      "league/routes/players.py": `
from fastapi import APIRouter, Depends
from league.routes.base.views import AdminView, MemberView, PublicView
from league.routes.base.routers import MemberRouter

router = APIRouter(prefix="/players")
member_router = MemberRouter(prefix="/squad")

@controller(router)
class PlayerAdmin(AdminView):
    @router.delete("/{player_id}")
    def delete(self, player_id: int):
        pass

@controller(router)
class PlayerPublic(PublicView):
    @router.get("")
    def list_players(self):
        pass

@controller(member_router)
class SquadView(MemberView):
    @member_router.get("")
    def squad(self):
        pass

class GuestView(MemberView):
    user = Depends(get_optional_user)

    @router.get("/guest")
    def guest(self):
        pass
`,
    });
    expect(guards(out)).toEqual([
      "DELETE /players/{player_id} [get_admin_user] Depends(get_admin_user)",
      "GET /players [] ",
      "GET /players/guest [] ",
      "GET /squad [get_current_user] Depends(get_current_user)",
    ]);
  });
});
