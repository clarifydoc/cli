/**
 * Java: a field initialized by an anonymous class is that class, and a builder chain typed hop by hop keeps
 * the certainty the qualified name alone states.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "java-anon-"));
  const out = await mkdtemp(join(tmpdir(), "java-anon-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "java" },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false },
      verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const rows = (a: FileAnalysis[], file: string) =>
  buildSymbolLinks(a).filter((l) => l.sourceFile === file)
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.confidence} ${l.strategy}`);

describe("Java field initialized by an anonymous class", () => {
  it("types the field by the anonymous class, or by its base when the body is empty", async () => {
    const a = await analyzeAll({
      "league/Other.java": "package league;\npublic class Other { public void run() {} }\n",
      "league/Kit.java": "package league;\npublic class Kit { public void assemble() {} }\n",
      "league/Worker.java": [
        "package league;",
        "public class Worker {",
        "    private final Runnable task = new Runnable() { public void run() { go(); } };",
        "    private Kit kit = new Kit() {};",
        "    void go() {}",
        "    void start() { this.task.run(); task.run(); kit.assemble(); }",
        "}", "",
      ].join("\n"),
    });
    const r = rows(a, "league/Worker.java");
    expect(r).toContain("this.task.run -> league/Worker.java::Runnable$3_34.run INFERRED injection");
    expect(r).toContain("task.run -> league/Worker.java::Runnable$3_34.run INFERRED injection");
    expect(r).toContain("kit.assemble -> league/Kit.java::Kit.assemble INFERRED injection");
    expect(r.some((x) => x.includes("Other.run"))).toBe(false);
  });
});

describe("anonymous class against a stated supertype", () => {
  it("keeps the declared type unless it is a var or names the class's own base", async () => {
    const a = await analyzeAll({
      "league/Base.java": "package league;\npublic class Base { public void go() {} }\n",
      "league/Impl.java": "package league;\npublic class Impl extends Base { public void go() {} }\n",
      "league/Worker.java": [
        "package league;",
        "public class Worker {",
        "    private Base held = new Impl() { public void go() { } };",
        "    void a() { Base b = new Impl() { public void go() { } }; b.go(); }",
        "    void c() { var v = new Base() { public void go() { } }; v.go(); }",
        "    void d() { held.go(); }",
        "}", "",
      ].join("\n"),
    });
    const links = buildSymbolLinks(a).filter((l) => l.sourceFile === "league/Worker.java");
    const target = (src: string, name: string) => links.find((l) => l.sourceSymbol === src && l.callName === name)?.targetSymbol;
    expect(target("Worker.a", "b.go")).not.toMatch(/\$/);
    expect(target("Worker.c", "v.go")).toMatch(/^Base\$\d+_\d+\.go$/);
    expect(target("Worker.d", "held.go")).not.toMatch(/\$/);
  });
});

describe("Lombok builder chain", () => {
  const files = {
    "league/model/Condition.java": "package league.model;\nimport lombok.Builder;\n@Builder\npublic class Condition { private String type; private String status; public void report() {} }\n",
    "league/Other.java": "package league;\npublic class Other { public Other status(String s) { return this; } }\n",
    "league/Worker.java": [
      "package league;", "import league.model.Condition;",
      "public class Worker { void make() { Condition.builder().type(\"a\").status(\"b\").message(\"c\").build(); } }", "",
    ].join("\n"),
  };
  it("stays EXTRACTED where the qualified name states the same target", async () => {
    const r = rows(await analyzeAll(files), "league/Worker.java");
    expect(r).toContain('Condition.builder().type("a").status("b").message("c").build -> league/model/Condition.java::ConditionBuilder.build EXTRACTED deep-qualified');
    expect(r.some((x) => x.includes("Other.status"))).toBe(false);
  });
});
