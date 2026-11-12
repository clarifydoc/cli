/**
 * Java / Kotlin value flow: a method reference travelling through locals, parameters, fields, returns and
 * collections to the call that runs it (`task.run()`, `cb()`, `f.invoke()`), through the real per-file pipeline and
 * the linker. Every positive has a same-named decoy (an ordinary class with its own `run()`) that must link nothing.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis, Language } from "../../../types/analysis.js";
import { isFunctionCollectionType, isFunctionType } from "./value-flow.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "jvm-vf-"));
  const out = await mkdtemp(join(tmpdir(), "jvm-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** `source: callName -> target` for every value-flow link, and every link a decoy might have drawn. */
function links(analyses: FileAnalysis[], strategy?: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => (strategy ? l.strategy === strategy : true) && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile.split("/").pop()}::${l.targetSymbol}${l.strategy === "value-flow" ? "" : ` [${l.strategy}]`}`)
    .sort();
}

describe("function types", () => {
  it("tells functions from ordinary types", () => {
    expect(isFunctionType("Runnable")).toBe(true);
    expect(isFunctionType("java.util.function.Supplier<Club>")).toBe(true);
    expect(isFunctionType("() -> Unit")).toBe(true);
    expect(isFunctionType("(() -> Unit)?")).toBe(true);
    expect(isFunctionType("suspend (Club) -> Unit")).toBe(true);
    expect(isFunctionType("Worker")).toBe(false);
    expect(isFunctionType("List<() -> Unit>")).toBe(false);
    expect(isFunctionCollectionType("List<Runnable>")).toBe(true);
    expect(isFunctionCollectionType("Map<String, () -> Unit>")).toBe(true);
    expect(isFunctionCollectionType("Runnable[]")).toBe(true);
    expect(isFunctionCollectionType("List<Club>")).toBe(false);
  });
});

describe("Java method references", () => {
  const files = {
    "league/Club.java": [
      "package league;",
      "import java.util.*;",
      "import java.util.function.*;",
      "public class Club {",
      "    private final Runnable task = this::save;",
      "    private Runnable later;",
      "    private final List<Runnable> handlers = new ArrayList<>();",
      "    void save() { }",
      "    void load() { }",
      "    void bench() { }",
      "    void wire() {",
      "        Runnable r = this::save;",
      "        Runnable q = r;",
      "        runIt(q);",
      "        this.later = this::load;",
      "        handlers.add(this::save);",
      "        handlers.add(this::load);",
      "    }",
      "    void runIt(Runnable w) { w.run(); }",
      "    void fire() { later.run(); task.run(); }",
      "    void all() { for (Runnable h : handlers) h.run(); }",
      "    Runnable factory() { return this::load; }",
      "    void use() { Runnable f = factory(); f.run(); }",
      "    void bound() { Club c = new Club(); Runnable z = c::save; z.run(); }",
      "    void unbound(Club c) { Consumer<Club> cc = Club::load; cc.accept(c); }",
      "    void make() { Supplier<Club> mk = Club::new; mk.get(); }",
      "}",
      "",
    ].join("\n"),
    "league/Task.java": ["package league;", "public class Task {", "    public void run() { }", "    public void get() { }", "}", ""].join("\n"),
    "league/Anon.java": [
      "package league;",
      "public class Anon {",
      "    void make() { Runnable handler = new Runnable() { public void run() { } }; handler.run(); }",
      "    void own() { Runnable r = new Task(); r.run(); }",
      "}",
      "",
    ].join("\n"),
    "league/Roster.java": [
      "package league;",
      "public class Roster {",
      "    void drill() { Task t = new Task(); t.run(); }",
      "    void bare(Task t) { var other = t; other.run(); }",
      "}",
      "",
    ].join("\n"),
  };

  it("follows a method reference to the call that runs it", async () => {
    const out = links(await analyzeAll(files, "java"), "value-flow");
    expect(out).toEqual([
      "Club.all: h.run -> Club.java::Club.load",
      "Club.all: h.run -> Club.java::Club.save",
      "Club.bound: z.run -> Club.java::Club.save",
      "Club.fire: later.run -> Club.java::Club.load",
      "Club.fire: task.run -> Club.java::Club.save",
      "Club.make: mk.get -> Club.java::Club",
      "Club.runIt: w.run -> Club.java::Club.save",
      "Club.unbound: cc.accept -> Club.java::Club.load",
      "Club.use: f.run -> Club.java::Club.load",
    ]);
  });

  it("never links a held-function call to a namesake, and leaves ordinary receivers alone", async () => {
    const all = links(await analyzeAll(files, "java"));
    // The functional-interface calls reach no `Task.run` / `Task.get`.
    expect(all.filter((l) => /^Club\.(runIt|fire|all|use|bound|unbound|make):/.test(l) && /Task\./.test(l))).toEqual([]);
    // An ordinary class's own `run()` still links by its receiver's type.
    expect(all).toContain("Roster.drill: t.run -> Task.java::Task.run [injection]");
    expect(all).toContain("Roster.bare: other.run -> Task.java::Task.run [injection]");
    expect(all.filter((l) => l.startsWith("Roster.") && l.includes("value-flow"))).toEqual([]);
    // A functional-interface local initialized by an object keeps the receiver path of the object it is.
    expect(all.filter((l) => l.startsWith("Anon.make: handler.run"))).toHaveLength(1);
    expect(links(await analyzeAll(files, "java"), "value-flow").filter((l) => l.startsWith("Anon."))).toEqual([]);
  });
});

describe("Kotlin callable references", () => {
  const files = {
    "league/Squad.kt": [
      "package league",
      "class Squad(private val onWhistle: () -> Unit) {",
      "    val handlers = listOf(::save, ::load)",
      "    val table = mapOf(\"save\" to ::save)",
      "    private var cb: () -> Unit = ::save",
      "    fun save() {}",
      "    fun load() {}",
      "    fun bench() {}",
      "    fun go() {",
      "        val f = ::save",
      "        val g = f",
      "        g()",
      "        f.invoke()",
      "        for (h in handlers) h()",
      "        table[\"save\"]?.invoke()",
      "        wrap(::load)",
      "        cb()",
      "        onWhistle()",
      "    }",
      "    fun wrap(fn: () -> Unit) { fn() }",
      "    fun mk(): () -> Unit = ::load",
      "    fun use() { val m = mk(); m() }",
      "}",
      "fun build() { Squad(::helper) }",
      "fun helper() {}",
      "",
    ].join("\n"),
    "league/Task.kt": ["package league", "class Task { fun invoke() {}; fun g() {}; fun fn() {}; fun cb() {}; fun m() {} }", ""].join("\n"),
  };

  it("follows a callable reference to the call that runs it", async () => {
    const out = links(await analyzeAll(files, "kotlin"), "value-flow");
    expect(out).toEqual([
      "Squad.go: cb -> Squad.kt::Squad.save",
      "Squad.go: f.invoke -> Squad.kt::Squad.save",
      "Squad.go: g -> Squad.kt::Squad.save",
      "Squad.go: h -> Squad.kt::Squad.load",
      "Squad.go: h -> Squad.kt::Squad.save",
      "Squad.go: onWhistle -> Squad.kt::helper",
      "Squad.go: table[\"save\"]?.invoke -> Squad.kt::Squad.save",
      "Squad.use: m -> Squad.kt::Squad.load",
      "Squad.wrap: fn -> Squad.kt::Squad.load",
    ]);
  });

  it("does not hand a function-typed call to a namesake", async () => {
    const all = links(await analyzeAll(files, "kotlin"));
    expect(all.filter((l) => /^Squad\./.test(l) && /Task\./.test(l))).toEqual([]);
  });
});
