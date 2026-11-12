import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A model handed by keyword, listed by a loop over a literal, or handed on by one helper to
 * another (real-repo FP shapes, renamed).
 */
describe("a model held by something other than a positional parameter, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-entity-held-"));
    const root = join(dir, "league");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "requirements.txt"), "fastapi\nsqlalchemy\n");
    await writeFile(join(root, "app", "__init__.py"), "");
    await writeFile(join(root, "app", "models.py"), [
      "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column",
      "class Base(DeclarativeBase):",
      "    pass",
      ...["Club:clubs", "Player:players", "Tag:tags", "Tool:tools", "Stadium:stadiums"].flatMap((m) => [
        `class ${m.split(":")[0]}(Base):`,
        `    __tablename__ = "${m.split(":")[1]}"`,
        "    id: Mapped[int] = mapped_column(primary_key=True)",
      ]),
    ].join("\n"));
    await writeFile(join(root, "app", "repository.py"), [
      "from sqlalchemy import func, select",
      "from app.models import Club, Player, Tag, Tool",
      "class LeagueStats:",
      "    pass",
      "def count_rows(session, model):",
      "    return session.scalar(select(func.count(model.id)))",
      "def inner_count(session, model):",
      "    return session.scalar(select(func.count(model.id)))",
      "def middle_count(session, kind):",
      "    return inner_count(session, model=kind)",
      "def outer_count(session, kind):",
      "    return middle_count(session, kind)",
      "def by_keyword(session):",
      "    return count_rows(session, model=Club)",
      "def by_splat(session, opts):",
      "    return count_rows(session, Club, **opts)",
      "def by_keyword_first(session):",
      "    return count_rows(model=Player, session=session)",
      "def by_non_entity(session):",
      "    return count_rows(session, model=LeagueStats)",
      "def by_mapping(session):",
      '    for field, model in {"tags": Tag, "tools": Tool}.items():',
      "        session.execute(select(model))",
      "def by_tuple(session):",
      "    for model in (Club, Player):",
      "        session.execute(select(model).limit(1))",
      "def by_chain(session):",
      "    return outer_count(session, Tag)",
      "def by_chain_keyword(session):",
      "    return outer_count(session, kind=Tool)",
    ].join("\n"));
    // The same helper name in another module, handed another model.
    await writeFile(join(root, "app", "stadiums.py"), [
      "from sqlalchemy import func, select",
      "from app.models import Stadium",
      "def count_rows(session, model):",
      "    return session.scalar(select(func.count(model.id)))",
      "def stadium_total(session):",
      "    return count_rows(session, model=Stadium)",
    ].join("\n"));
    await writeFile(join(root, "app", "routes.py"), [
      "from fastapi import APIRouter",
      "from app import repository, stadiums",
      "router = APIRouter()",
      ...["by_keyword", "by_splat", "by_keyword_first", "by_non_entity", "by_mapping", "by_tuple", "by_chain", "by_chain_keyword"].flatMap((m) => [
        `@router.get("/api/v2/league/${m}")`,
        `def league_${m}(session):`,
        `    return repository.${m}(session)`,
      ]),
      '@router.get("/api/v2/league/stadium_total")',
      "def league_stadium_total(session):",
      "    return stadiums.stadium_total(session)",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reaches the model a keyword, a literal loop or a handed-on parameter names", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const reached = [...new Set((summary.dataFlows ?? [])
      .filter((f) => f.entryKind === "route" && f.effect === "db-read")
      .map((f) => `${f.entryLabel.replace("GET /api/v2/league/", "")} ${f.resource}`))].sort();
    expect(reached).toEqual([
      "by_chain Tag",
      "by_chain_keyword Tool",
      "by_keyword Club",
      "by_keyword_first Player",
      "by_mapping Tag",
      "by_mapping Tool",
      "by_splat Club",
      "by_tuple Club",
      "by_tuple Player",
      "stadium_total Stadium",
    ]);
  });
});
