import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (parse + every extractor). */
async function analyze(src: string, rel = "app/models.py"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "py-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "py-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "python" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const entities = (a: FileAnalysis) => a.classes.filter((c) => c.decorators?.includes("entity")).map((c) => c.name);

describe("Python entities — SQLModel Relationship (nested serializer-style)", () => {
  it("reads table=True Relationship fields as relations; nested schema fields stay out", async () => {
    const a = await analyze(`from typing import Optional
from sqlmodel import Field, Relationship, SQLModel

class League(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    clubs: list["Club"] = Relationship(back_populates="league")

class Club(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    league_id: Optional[int] = Field(default=None, foreign_key="league.id")
    league: Optional["League"] = Relationship(back_populates="clubs")

# Decoy: same nested field shape on a non-table SQLModel schema — not an entity,
# and league: LeagueRead must not become a ClubRead -> LeagueRead relation.
class LeagueRead(SQLModel):
    id: int
    name: str

class ClubRead(SQLModel):
    id: int
    name: str
    league: Optional[LeagueRead] = None
`);
    expect(entities(a).sort()).toEqual(["Club", "League"]);
    const rels = (a.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity} (${r.cardinality})`);
    expect(rels).toEqual(expect.arrayContaining([
      "Club.league -> League (many-to-one)",
      "League.clubs -> Club (one-to-many)",
    ]));
    expect(rels.some((r) => r.includes("ClubRead") || r.includes("LeagueRead"))).toBe(false);
    expect(rels.filter((r) => r.startsWith("Club.league_id")).length).toBeLessThanOrEqual(1);
  });
});

describe("Python entities — SQLAlchemy bases and Flask-SQLAlchemy", () => {
  it("does not take the declarative base for an entity", async () => {
    const a = await analyze(`from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Player(Base):
    __tablename__ = "players"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(entities(a)).toEqual(["Player"]);
  });

  it("reads db.Model classes, their db.Column fields and db.relationship / db.ForeignKey", async () => {
    const a = await analyze(`from flask_sqlalchemy import SQLAlchemy
db = SQLAlchemy()

class Scout(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80))
    games = db.relationship("Game", back_populates="scout")

class Game(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    scout_id = db.Column(db.Integer, db.ForeignKey("scout.id"))
`);
    expect(entities(a).sort()).toEqual(["Game", "Scout"]);
    const scout = a.classes.find((c) => c.name === "Scout")!;
    expect(scout.properties.map((p) => `${p.name}:${p.type}`)).toEqual(expect.arrayContaining(["id:Integer", "name:String"]));
    expect((a.entityRelations ?? []).map((r) => `${r.fromEntity} -> ${r.toEntity}`)).toEqual(expect.arrayContaining(["Scout -> Game"]));
  });
});

describe("Python entities — Django migrations", () => {
  it("does not take a migration whose operations name model fields for a model (real-repo FP)", async () => {
    const a = await analyze(`from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("league", "0044_club_groups")]

    operations = [
        migrations.AddField(
            model_name="club",
            name="capacity",
            field=models.IntegerField(blank=True, null=True),
        ),
    ]
`, "league/migrations/0045_club_capacity.py");
    expect(entities(a)).toEqual([]);
  });
});

describe("Python entities — Alembic revisions", () => {
  it("does not take a revision's model copies for the application's models (real-repo FP)", async () => {
    const a = await analyze(`"""add unique constraints"""
import sqlalchemy as sa
from sqlalchemy import orm

revision = "dded3119c1fe"
down_revision = "0341b154f79a"


class SqlAlchemyBase(orm.DeclarativeBase):
    pass


class Fixture(SqlAlchemyBase):
    __tablename__ = "fixtures"
    id: orm.Mapped[int] = orm.mapped_column(sa.Integer, primary_key=True)


def upgrade():
    pass
`, "league/alembic/versions/2023-10-04_dded3119c1fe_added_unique_constraints.py");
    expect(entities(a)).toEqual([]);
  });

  it("reads op.create_table schema= as a schema-qualified table; bare and wrong-schema decoys stay apart", async () => {
    const a = await analyze(`"""add clubs"""
from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = None


def upgrade() -> None:
    op.create_table(
        "clubs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        schema="league",
    )
    op.create_table(
        "clubs",
        sa.Column("id", sa.Integer(), primary_key=True),
    )
    op.create_table(
        "clubs",
        sa.Column("id", sa.Integer(), primary_key=True),
        schema="cup",
    )


def downgrade() -> None:
    op.drop_table("clubs", schema="league")
    op.drop_table("clubs")
    op.drop_table("clubs", schema="cup")
`, "alembic/versions/a1b2c3d4e5f6_add_clubs.py");
    expect(entities(a)).toEqual([]);
    const tables = a.classes.filter((c) => c.decorators?.includes("table")).map((c) => c.name).sort();
    expect(tables).toEqual(["clubs", "cup.clubs", "league.clubs"]);
    // Downgrade's drop_table is ignored — it would wipe the same file's creates.
    expect((a.schemaOps ?? []).map((o) => `${o.op} ${o.table}`).sort()).toEqual([
      "create-table clubs",
      "create-table cup.clubs",
      "create-table league.clubs",
    ]);
    const league = a.classes.find((c) => c.name === "league.clubs")!;
    expect(league.properties.map((p) => p.name)).toEqual(["id", "name"]);
  });

  it("prefixes a model's __tablename__ with __table_args__ schema so it joins the migration table", async () => {
    const a = await analyze(`from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, Integer


class Base(DeclarativeBase):
    pass


class Club(Base):
    __tablename__ = "clubs"
    __table_args__ = {"schema": "league"}
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))


class CupClub(Base):
    __tablename__ = "clubs"
    __table_args__ = {"schema": "cup"}
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
`);
    const club = a.classes.find((c) => c.name === "Club")!;
    const cup = a.classes.find((c) => c.name === "CupClub")!;
    expect(club.tableName).toBe("league.clubs");
    expect(cup.tableName).toBe("cup.clubs");
  });
});
