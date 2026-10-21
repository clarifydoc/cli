import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis, Language } from "../../types/analysis.js";

/** Through the real per-file pipeline (parse + every extractor). */
async function analyze(src: string, rel: string, language: Language): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "tbl-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "tbl-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const tables = (a: FileAnalysis) =>
  Object.fromEntries(a.classes.filter((c) => c.decorators?.includes("entity")).map((c) => [c.name, c.tableName ?? null]));

/**
 * The physical table an entity maps to, where the code names one: raw SQL
 * and mapper XML name the table, so access matching needs it beside the
 * class name (`ClassInfo.tableName` → `EntityGraphNode.table`).
 */
describe("entity table names", () => {
  it("Python: __tablename__, Django db_table, peewee table_name — and no name where none is written", async () => {
    const a = await analyze(
      `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from django.db import models
import peewee

class Base(DeclarativeBase):
    pass

class Player(Base):
    __tablename__ = "app_players"
    id: Mapped[int] = mapped_column(primary_key=True)

class Car(models.Model):
    total = models.IntegerField()

    class Meta:
        db_table = "shop_cars"

class Tag(peewee.Model):
    name = peewee.CharField()

    class Meta:
        table_name = "tags_v2"

class Note(models.Model):
    body = models.TextField()
`,
      "app/models.py",
      "python",
    );
    expect(tables(a)).toEqual({ Player: "app_players", Car: "shop_cars", Tag: "tags_v2", Note: null });
  });

  it("Java: @Table(name = …), with a schema, and Spring Data JDBC's @Table(\"…\")", async () => {
    const a = await analyze(
      `package com.acme;
import jakarta.persistence.*;

@Entity
@Table(schema = "core", name = "app_players")
public class Player {
  @Id private Long id;
}
`,
      "src/main/java/com/acme/Player.java",
      "java",
    );
    expect(tables(a)).toEqual({ Player: "app_players" });
  });

  it("TypeScript: TypeORM @Entity(\"…\") and @Entity({ name }), Sequelize tableName", async () => {
    const a = await analyze(
      `import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
import { DataTypes } from "sequelize";

@Entity("app_players")
export class Player {
  @PrimaryGeneratedColumn() id: number;
}

@Entity({ name: "shop_cars" })
export class Car {
  @Column() total: number;
}

export const Tag = sequelize.define("Tag", { name: DataTypes.STRING }, { tableName: "tags_v2" });
`,
      "src/entities.ts",
      "typescript",
    );
    expect(tables(a)).toEqual({ Player: "app_players", Car: "shop_cars", Tag: "tags_v2" });
  });
});
