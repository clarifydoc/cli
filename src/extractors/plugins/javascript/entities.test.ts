import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (parse + every extractor). */
async function analyze(src: string, rel = "src/db/schema.ts"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "ts-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "ts-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
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

describe("JS entities — Drizzle tables", () => {
  it("reads pgTable/sqliteTable definitions, their columns and references", async () => {
    const a = await analyze(`import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
});

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  title: text("title"),
  scoutId: integer("scout_id").references(() => players.id, { onDelete: "cascade" }),
});
`);
    expect(entities(a).sort()).toEqual(["games", "players"]);
    const games = a.classes.find((c) => c.name === "games")!;
    expect(games.properties.map((p) => `${p.name}:${p.type}`)).toEqual(["id:serial", "title:text", "scoutId:integer"]);
    expect((a.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity} (${r.foreignKey})`)).toEqual(["games.scoutId -> players (scoutId)"]);
  });
});

describe("@Table schema classes (sequelize-typescript, a schema DSL)", () => {
  it("reads the table, its columns and a foreign-key column as a relation (real-repo FP: 67 tables missing)", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { JavaScriptExtractor } = await import("./functions-classes.js");
    const { JavaScriptEntityExtractor } = await import("./entities.js");
    const src = `import { Column, CreateDateColumn, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@league/sql-tools';
import { StadiumTable } from './stadium.table';

@Table({ name: 'club' })
export class ClubTable {
  @PrimaryGeneratedColumn()
  id!: string;

  @Column({ default: 'Unnamed Club' })
  clubName!: string;

  @ForeignKeyColumn(() => StadiumTable, { nullable: true, onDelete: 'SET NULL' })
  homeStadiumId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
`;
    const tree = await parseSource(src, "typescript" as never, "club.table.ts");
    const x = new JavaScriptExtractor();
    const analysis = { filePath: "club.table.ts", language: "typescript", classes: x.extractClasses(tree, src), functions: [], imports: [{ source: "@league/sql-tools", specifiers: ["Column", "CreateDateColumn", "ForeignKeyColumn", "PrimaryGeneratedColumn", "Table"], isDefault: false, isNamespace: false, isType: false, line: 1 }] } as never;
    const res = new JavaScriptEntityExtractor().extract({ analysis, sourceText: src, lines: src.split("\n"), tree } as never);
    const club = res.entities.find((e) => e.name === "ClubTable")!;
    expect(club.tableName).toBe("club");
    expect(club.properties.map((p) => p.name)).toEqual(["id", "clubName", "homeStadiumId", "createdAt"]);
    expect(res.relations).toEqual([expect.objectContaining({ fromEntity: "ClubTable", toEntity: "StadiumTable", cardinality: "many-to-one", foreignKey: "homeStadiumId" })]);
  });
});
