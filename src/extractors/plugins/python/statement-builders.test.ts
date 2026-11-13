import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";

const MODELS = `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Club(Base):
    __tablename__ = "clubs"
    id = Column(Integer, primary_key=True)


class Player(Base):
    __tablename__ = "players"
    id = Column(Integer, primary_key=True)
    club_id = Column(Integer)
`;

const REPO = `import sqlalchemy as sa
from sqlalchemy import select, func
from models import Club, Player


def count_players(session, club_id):
    return session.execute(select(func.count(Player.id)).filter_by(club_id=club_id)).scalar()


def count_any(session, model):
    return session.execute(select(func.count(model.id)).filter_by(active=True)).scalar()


def count_via_module(session, model):
    return session.scalar(sa.select(sa.func.count(model.id)))


def club_filter():
    return select(Club).filter_by(name="Rovers")


def clubs(session):
    return session.query(Club).all()
`;

describe("SQLAlchemy statement builders are no table (real-repo FP)", () => {
  let dir = "";
  let rows: DataSourceInfo[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-py-builders-"));
    await mkdir(join(dir, "repo"), { recursive: true });
    await writeFile(join(dir, "repo", "models.py"), MODELS);
    await writeFile(join(dir, "repo", "repo.py"), REPO);
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const file = JSON.parse(await readFile(join(dir, "out", "repo.py.json"), "utf8")) as FileAnalysis;
    rows = file.dataSources.filter((d) => d.kind === "database");
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("never targets the library or its module alias", () => {
    expect(rows.filter((d) => d.target === "sqlalchemy" || d.target === "sa" || d.target === "func")).toEqual([]);
  });

  it("targets the declared model's table for select(func.count(Model.id)).filter_by(...)", () => {
    expect(rows.filter((d) => d.line === 7).map((d) => d.target)).toEqual(["Player"]);
  });

  it("leaves a helper's parameter model to the session call's own row", () => {
    expect(rows.filter((d) => d.line === 11).map((d) => [d.target, d.entityParameter ?? null])).toEqual([[null, "model"]]);
    expect(rows.filter((d) => d.line === 15).map((d) => [d.target, d.entityParameter ?? null])).toEqual([[null, "model"]]);
  });

  it("reads the model a bare select(Model).filter_by names", () => {
    expect(rows.filter((d) => d.line === 19).map((d) => d.target)).toEqual(["Club"]);
  });
});
