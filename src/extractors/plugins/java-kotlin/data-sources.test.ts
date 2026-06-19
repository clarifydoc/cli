import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";

async function sourcesOf(body: string, lang: Language): Promise<DataSourceInfo[]> {
  const ext = lang === "kotlin" ? "kt" : "java";
  const src =
    lang === "kotlin"
      ? `package x
class Repo {
  fun m(id: Int) {
${body}
  }
}`
      : `package x;
class Repo {
  void m(int id) {
${body}
  }
}`;
  const tree = await parseSource(src, lang as any, `Repo.${ext}`);
  return new JavaKotlinDataSourceExtractor().extract(tree, src);
}

const db = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "database");

describe("Kotlin jOOQ data-source extraction (was completely blind before)", () => {
  it("captures the table from a `.from(CONSTANT)` chain → entity", async () => {
    const s = db(
      await sourcesOf(
        `    val r = dsl.select(field("x")).from(STUDENT).where(field("id").eq(id)).fetch()`,
        "kotlin",
      ),
    );
    expect(s.some((d) => d.entity === "STUDENT" && d.target === "STUDENT")).toBe(true);
  });

  it("captures `selectFrom(table(\"sps.Module\"))` and strips the schema prefix", async () => {
    const s = db(await sourcesOf(`    val r = dsl.selectFrom(table("sps.Module")).fetch()`, "kotlin"));
    expect(s.some((d) => d.entity === "Module")).toBe(true);
  });

  it("captures `insertInto(Tables.MODULESETTING)` (qualified constant → last segment)", async () => {
    const s = db(await sourcesOf(`    dsl.insertInto(Tables.MODULESETTING).set(x, y).execute()`, "kotlin"));
    expect(s.some((d) => d.entity === "MODULESETTING" && d.name === "jOOQ: insertInto")).toBe(true);
  });

  it("does NOT treat lowercase-local `update(student)` as a jOOQ table touch", async () => {
    const s = db(await sourcesOf(`    service.update(student)`, "kotlin"));
    expect(s.some((d) => d.name.startsWith("jOOQ:"))).toBe(false);
  });

  it("does NOT treat `LocalDate.from(value)` as a jOOQ table touch", async () => {
    const s = db(await sourcesOf(`    val d = LocalDate.from(value)`, "kotlin"));
    expect(s.length).toBe(0);
  });

  it("resolves a file-local `val TABLE = DSL.table(\"X\")` alias to the real table", async () => {
    // Class-level alias binding + a method that queries it.
    const src = `package x
class Dao {
  private val TABLE = DSL.table("CaseExternalSupportUser")
  fun load(id: Int) {
    val r = dsl.select(field("id")).from(TABLE).fetch()
  }
}`;
    const tree = await parseSource(src, "kotlin" as any, "Dao.kt");
    const s = db(new JavaKotlinDataSourceExtractor().extract(tree, src));
    expect(s.some((d) => d.entity === "CaseExternalSupportUser")).toBe(true);
    expect(s.some((d) => d.entity === "TABLE")).toBe(false);
  });

  it("resolves an inline `.from(GRANTITEM.as(\"gi\"))` alias to the table", async () => {
    const s = db(await sourcesOf(`    val r = dsl.select().from(GRANTITEM.as("gi")).fetch()`, "kotlin"));
    expect(s.some((d) => d.entity === "GRANTITEM")).toBe(true);
  });
});

describe("Java jOOQ + Spring Data", () => {
  it("captures jOOQ table on the Java AST too", async () => {
    const s = db(await sourcesOf(`    var r = dsl.deleteFrom(REIMBURSEMENT).where(c).execute();`, "java"));
    expect(s.some((d) => d.entity === "REIMBURSEMENT" && d.name === "jOOQ: deleteFrom")).toBe(true);
  });

  it("still recognises Spring Data repository methods (Kotlin too)", async () => {
    const kt = db(await sourcesOf(`    repo.findByEmail("a"); repo.save(x); repo.deleteById(id)`, "kotlin"));
    expect(kt.map((d) => d.name).sort()).toEqual(["deleteById", "findByEmail", "save"]);
  });

  it("does NOT flag `file.delete()` or a plain getter as DB access", async () => {
    const s = db(await sourcesOf(`    file.delete(); var n = user.getName();`, "java"));
    expect(s.length).toBe(0);
  });
});
