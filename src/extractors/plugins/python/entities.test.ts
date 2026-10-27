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
