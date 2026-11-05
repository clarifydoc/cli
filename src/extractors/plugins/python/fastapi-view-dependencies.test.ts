import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: `return self.user` on a class-based view whose base loads the user in a dependency reached no table. */
const FILES: Record<string, string> = {
  "requirements.txt": "fastapi==0.110\nsqlalchemy==2.0\n",
  "league/db/models.py": `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Player(Base):
    __tablename__ = "players"
    id: Mapped[int] = mapped_column(primary_key=True)
`,
  "league/core/deps.py": `from fastapi import Depends
from sqlalchemy import select
from league.db.models import Player


def get_current_player(session=Depends(get_session)) -> Player:
    return session.scalars(select(Player)).one()


def get_locale() -> str:
    return "en"
`,
  "league/routes/base.py": `from fastapi import Depends
from league.core.deps import get_current_player, get_locale


class BaseView:
    locale: str = Depends(get_locale)


class BasePlayerView(BaseView):
    player: Player = Depends(get_current_player)
`,
  "league/routes/players.py": `from fastapi import APIRouter
from league.routes.base import BasePlayerView

router = APIRouter(prefix="/players")


@controller(router)
class PlayerView(BasePlayerView):
    @router.get("/self")
    def get_self(self):
        return self.player
`,
  "league/main.py": `from fastapi import FastAPI
from league.routes import players

app = FastAPI()
app.include_router(players.router, prefix="/api")
`,
};

describe("a FastAPI class-based view's dependencies", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-view-dependencies-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("run before each endpoint, so the route reaches what they read", () => {
    const route = summary.routeMap.find((r) => r.path.endsWith("/players/self"));
    expect(route).toBeDefined();
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route" && f.entryFile === "league/routes/players.py").map((f) => `${f.entryLabel} ${f.resource}`);
    expect(flows).toEqual([`GET ${route!.path} Player`]);
    const deps = summary.symbolLinks
      .filter((l) => l.sourceFile === "league/routes/players.py" && l.sourceSymbol.startsWith("route:"))
      .map((l) => `${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(deps).toEqual(expect.arrayContaining(["league/core/deps.py::get_current_player", "league/core/deps.py::get_locale"]));
  });
});
