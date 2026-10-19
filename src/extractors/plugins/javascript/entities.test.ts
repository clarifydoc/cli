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

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title"),
  authorId: integer("author_id").references(() => users.id, { onDelete: "cascade" }),
});
`);
    expect(entities(a).sort()).toEqual(["posts", "users"]);
    const posts = a.classes.find((c) => c.name === "posts")!;
    expect(posts.properties.map((p) => `${p.name}:${p.type}`)).toEqual(["id:serial", "title:text", "authorId:integer"]);
    expect((a.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity} (${r.foreignKey})`)).toEqual(["posts.authorId -> users (authorId)"]);
  });
});
