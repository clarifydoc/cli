import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A helper whose statement counts the model its caller hands it:
 * `def model_count(model): select(func.count(model.id))`, called `model_count(ClubModel)`.
 */
describe("a model handed to a query helper, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-entity-param-"));
    const root = join(dir, "league");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "requirements.txt"), "fastapi\nsqlalchemy\n");
    await writeFile(join(root, "app", "__init__.py"), "");
    await writeFile(join(root, "app", "models.py"), [
      "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column",
      "class Base(DeclarativeBase):",
      "    pass",
      "class ClubModel(Base):",
      '    __tablename__ = "clubs"',
      "    id: Mapped[int] = mapped_column(primary_key=True)",
      "class PlayerModel(Base):",
      '    __tablename__ = "players"',
      "    id: Mapped[int] = mapped_column(primary_key=True)",
      "class StadiumModel(Base):",
      '    __tablename__ = "stadiums"',
      "    id: Mapped[int] = mapped_column(primary_key=True)",
    ].join("\n"));
    await writeFile(join(root, "app", "repository.py"), [
      "from sqlalchemy import func, select",
      "from app.models import Base, ClubModel, PlayerModel",
      "class LeagueStats:",
      "    def __init__(self, clubs, players):",
      "        self.clubs = clubs",
      "def count_rows(session, model):",
      "    return session.scalar(select(func.count(model.id)))",
      "class LeagueRepository:",
      "    def __init__(self, session):",
      "        self.session = session",
      "    def statistics(self):",
      "        def model_count(model: type[Base]) -> int:",
      "            stmt = select(func.count(model.id))",
      "            return self.session.scalar(stmt)",
      "        return LeagueStats(",
      "            clubs=model_count(ClubModel),",
      "            players=model_count(PlayerModel),",
      "        )",
      "    def club_total(self):",
      "        return count_rows(self.session, ClubModel)",
      "    def _count(self, model):",
      "        return self.session.scalar(select(func.count(model.id)))",
      "    def player_total(self):",
      "        return self._count(PlayerModel)",
      "    def both(self):",
      "        def model_count(model):",
      "            return self.session.scalar(select(func.count(model.id)))",
      "        return (model_count(ClubModel), model_count(PlayerModel))",
      "    def not_a_model(self):",
      "        return self._count(LeagueStats)",
    ].join("\n"));
    await writeFile(join(root, "app", "routes.py"), [
      "from fastapi import APIRouter",
      "from app.repository import LeagueRepository",
      "router = APIRouter()",
      ...["statistics", "club_total", "player_total", "both", "not_a_model"].flatMap((m) => [
        `@router.get("/api/v2/league/${m}")`,
        `def league_${m}(session):`,
        `    return LeagueRepository(session).${m}()`,
      ]),
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("binds the helper's parameter to the entity class each call hands it", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const reached = [...new Set((summary.dataFlows ?? [])
      .filter((f) => f.entryKind === "route" && f.effect === "db-read")
      .map((f) => `${f.entryLabel} ${f.resource}`))].sort();
    expect(reached).toEqual([
      "GET /api/v2/league/both ClubModel",
      "GET /api/v2/league/both PlayerModel",
      "GET /api/v2/league/club_total ClubModel",
      "GET /api/v2/league/player_total PlayerModel",
      "GET /api/v2/league/statistics ClubModel",
      "GET /api/v2/league/statistics PlayerModel",
    ]);
    // A class no call hands the helper is never reached, nor a class that is no entity.
    expect(reached.some((r) => /StadiumModel|LeagueStats|not_a_model/.test(r))).toBe(false);
  });
});
