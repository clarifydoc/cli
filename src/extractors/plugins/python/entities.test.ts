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

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(entities(a)).toEqual(["User"]);
  });

  it("reads db.Model classes, their db.Column fields and db.relationship / db.ForeignKey", async () => {
    const a = await analyze(`from flask_sqlalchemy import SQLAlchemy
db = SQLAlchemy()

class Author(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80))
    posts = db.relationship("Post", back_populates="author")

class Post(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    author_id = db.Column(db.Integer, db.ForeignKey("author.id"))
`);
    expect(entities(a).sort()).toEqual(["Author", "Post"]);
    const author = a.classes.find((c) => c.name === "Author")!;
    expect(author.properties.map((p) => `${p.name}:${p.type}`)).toEqual(expect.arrayContaining(["id:Integer", "name:String"]));
    expect((a.entityRelations ?? []).map((r) => `${r.fromEntity} -> ${r.toEntity}`)).toEqual(expect.arrayContaining(["Author -> Post"]));
  });
});
