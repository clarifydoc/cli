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

describe("Kotlin lambdas as values", () => {
  const files = {
    "league/Club.kt": ["package league", "class Club { fun save() {} }", ""].join("\n"),
    "league/Match.kt": [
      "package league",
      "class Match(private val club: Club) {",
      "    private var onDone: () -> Unit = { refreshTable() }",
      "    private val handlers = mutableMapOf<String, () -> Unit>()",
      "    fun kickOff() {}",
      "    fun closeMatch() {}",
      "    fun refreshTable() {}",
      "    fun wire() {",
      "        val cb = { kickOff() }",
      "        cb()",
      "        wrapIt { club.save() }",
      "        handlers[\"close\"] = { closeMatch() }",
      "        val again: () -> Unit = { onDone() }",
      "        again()",
      "    }",
      "    fun wrapIt(w: () -> Unit) { w() }",
      "    fun finish() { onDone() }",
      "    fun dispatch() { handlers[\"close\"]?.invoke() }",
      "    fun factory(): () -> Unit { return { closeMatch() } }",
      "    fun use() { val f = factory(); f() }",
      "    fun many() { val m = { kickOff(); closeMatch(); refreshTable(); wire(); finish() }; m() }",
      "    fun viaIt() { val c: (Club) -> Unit = { it.save() }; c(club) }",
      "    fun viaBare() { val h: (() -> Unit) -> Unit = { fn -> fn() }; h { kickOff() } }",
      "    fun viaNamed() { val c: (Club) -> Unit = { x -> x.save() }; c(club) }",
      "}",
      "",
    ].join("\n"),
    "league/Decoy.kt": ["package league", "class Decoy { fun invoke() {}; fun kickOff() {}; fun closeMatch() {}; fun refreshTable() {}; fun save() {}; fun w() {}; fun cb() {}; fun f() {}; fun m() {}; fun c() {}; fun again() {}; fun fn() {} }", ""].join("\n"),
  };

  it("makes a lambda stand for the functions its body calls", async () => {
    const out = links(await analyzeAll(files, "kotlin"), "value-flow");
    expect(out).toEqual([
      // a map of lambdas read by key, a field initializer, a factory's result, a local lambda
      "Match.dispatch: handlers[\"close\"]?.invoke -> Match.kt::Match.closeMatch",
      "Match.finish: onDone -> Match.kt::Match.refreshTable",
      "Match.use: f -> Match.kt::Match.closeMatch",
      "Match.wire: cb -> Match.kt::Match.kickOff",
      // a lambda that runs a held function holds what it holds (and `onDone()` itself runs the initializer's lambda)
      "Match.wire: again -> Match.kt::Match.refreshTable",
      "Match.wire: onDone -> Match.kt::Match.refreshTable",
      // a trailing lambda handed to a wrapper that runs its parameter
      "Match.wrapIt: w -> Club.kt::Club.save",
    ].sort());
    // Five calls, and a call on the lambda's own parameter (implicit `it` or named), state nothing.
    expect(out.filter((l) => /^Match\.(many|viaIt|viaNamed|viaBare):/.test(l))).toEqual([]);
    expect(out.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("Java lambdas as values", () => {
  const files = {
    "league/Club.java": ["package league;", "public class Club {", "    public void save() { }", "}", ""].join("\n"),
    "league/Match.java": [
      "package league;",
      "import java.util.*;",
      "import java.util.function.*;",
      "public class Match {",
      "    private Runnable onDone;",
      "    private final Map<String, Runnable> handlers = new HashMap<>();",
      "    private final Runnable kick = () -> kickOff();",
      "    void kickOff() { }",
      "    void closeMatch() { }",
      "    void refreshTable() { }",
      "    void wire(Club club) {",
      "        Runnable r = () -> club.save();",
      "        wrapIt(r);",
      "        this.onDone = () -> refreshTable();",
      "        handlers.put(\"close\", () -> closeMatch());",
      "        Runnable chained = () -> onDone.run();",
      "        chained.run();",
      "    }",
      "    void wrapIt(Runnable w) { w.run(); }",
      "    void finish() { onDone.run(); kick.run(); }",
      "    void dispatch() { handlers.get(\"close\").run(); }",
      "    Runnable factory() { return () -> closeMatch(); }",
      "    void use() { Runnable f = factory(); f.run(); }",
      "    void many() { Runnable m = () -> { kickOff(); closeMatch(); refreshTable(); wire(null); finish(); }; m.run(); }",
      "    void pair() { Runnable m = () -> { kickOff(); closeMatch(); }; m.run(); }",
      "    void viaParam() { Consumer<Club> c = club -> club.save(); c.accept(null); }",
      "    void constructed() { Runnable t = () -> new Club(); t.run(); }",
      "}",
      "",
    ].join("\n"),
    "league/Decoy.java": [
      "package league;",
      "public class Decoy {",
      "    public void run() { }",
      "    public void kickOff() { }",
      "    public void closeMatch() { }",
      "    public void refreshTable() { }",
      "    public void save() { }",
      "}",
      "",
    ].join("\n"),
  };

  it("makes a lambda stand for the functions its body calls", async () => {
    const out = links(await analyzeAll(files, "java"), "value-flow");
    expect(out).toEqual([
      // a map of lambdas read by key, a field a lambda was assigned to, a field initializer, a factory's result
      "Match.dispatch: handlers.get(\"close\").run -> Match.java::Match.closeMatch",
      "Match.finish: kick.run -> Match.java::Match.kickOff",
      "Match.finish: onDone.run -> Match.java::Match.refreshTable",
      "Match.use: f.run -> Match.java::Match.closeMatch",
      // a lambda that runs a held function holds what it holds
      "Match.wire: chained.run -> Match.java::Match.refreshTable",
      // `onDone.run()` inside the local lambda is a call of `wire` itself now (the lambda is read on its behalf), as in Kotlin
      "Match.wire: onDone.run -> Match.java::Match.refreshTable",
      // a lambda handed to a wrapper that runs its parameter; a body of two calls is both of them
      "Match.wrapIt: w.run -> Club.java::Club.save",
      "Match.pair: m.run -> Match.java::Match.closeMatch",
      "Match.pair: m.run -> Match.java::Match.kickOff",
    ].sort());
    // Five calls, a call on the lambda's own parameter and a construction state nothing; the namesake is never reached.
    expect(out.filter((l) => /^Match\.(many|viaParam|constructed):/.test(l))).toEqual([]);
    expect(out.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("Java lambda bound to a local: its calls are the method's", () => {
  const files = {
    "league/Club.java": ["package league;", "public class Club {", "    public void save() { }", "}", ""].join("\n"),
    "league/Match.java": [
      "package league;",
      "public class Match {",
      "    private final Runnable kick = () -> kickOff();",
      "    void kickOff() { }",
      "    void wire(Club club) {",
      "        Runnable r = () -> club.save();",
      "        runIt(r);",
      "    }",
      "    void runIt(Runnable w) { w.run(); }",
      "}",
      "",
    ].join("\n"),
    "league/Decoy.java": ["package league;", "public class Decoy {", "    public void save() { }", "    public void kickOff() { }", "}", ""].join("\n"),
  };

  it("records the lambda's calls on the enclosing method and links them", async () => {
    const analyses = await analyzeAll(files, "java");
    const match = analyses.find((a) => a.filePath.endsWith("Match.java"));
    const wire = match?.classes.flatMap((c) => c.methods).find((m) => m.name === "wire");
    expect(wire?.calls.filter((c) => c.name === "club.save").map((c) => c.line)).toEqual([6]);
    const out = links(analyses, "value-flow");
    expect(out).toContain("Match.runIt: w.run -> Club.java::Club.save");
    expect(out.filter((l) => l.includes("Decoy"))).toEqual([]);
  });
});

describe("calls into a library state no argument facts", () => {
  /** The `call` of every `arg` fact the named member states. */
  const argCalls = (a: FileAnalysis, member: string): string[] =>
    [...a.functions, ...a.classes.flatMap((c) => c.methods ?? [])]
      .filter((f) => f.name === member)
      .flatMap((f) => (f.valueFlow ?? []).filter((v) => v.kind === "arg").map((v) => (v as { call: string }).call))
      .sort();

  it("Java: a statically imported route DSL states none, a project function still links, a declared `post` is the project's", async () => {
    const analyses = await analyzeAll(
      {
        "league/Table.java": ["package league;", "public class Table {", "    public void save() { }", "}", ""].join("\n"),
        "league/Routes.java": [
          "package league;",
          "import static spark.Spark.*;",
          "public class Routes {",
          "    private final Table table = new Table();",
          "    static void register(Runnable r) { r.run(); }",
          "    static void post(String path, Runnable r) { r.run(); }",
          "    void wire() {",
          "        patch(\"/clubs\", () -> table.save());",
          "        register(() -> table.save());",
          "        post(\"/own\", () -> table.save());",
          "    }",
          "}",
          "",
        ].join("\n"),
        "league/Dsl.java": [
          "package league;",
          "import static spark.Spark.*;",
          "public class Dsl {",
          "    private final Table table = new Table();",
          "    void wire() {",
          "        path(\"/clubs\", () -> { after(\"/x\", (req, res) -> table.save()); });",
          "    }",
          "}",
          "",
        ].join("\n"),
        "league/Decoy.java": ["package league;", "public class Decoy {", "    public void save() { }", "}", ""].join("\n"),
      },
      "java",
    );
    const dsl = analyses.find((a) => a.filePath === "league/Dsl.java")!;
    expect(argCalls(dsl, "wire")).toEqual([]);
    const routes = analyses.find((a) => a.filePath === "league/Routes.java")!;
    // `patch` is the library's (imported, not declared); `register` and the file's own `post` are the project's.
    expect(argCalls(routes, "wire")).toEqual(["post", "register"]);
    expect(links(analyses, "value-flow").filter((l) => l.includes("Decoy"))).toEqual([]);
    expect(links(analyses, "value-flow")).toContain("Routes.register: r.run -> Table.java::Table.save");
  });

  it("Java: a receiver typed by an imported library class is a library call", async () => {
    const analyses = await analyzeAll(
      {
        "league/Table.java": ["package league;", "public class Table {", "    public void save() { }", "}", ""].join("\n"),
        "league/Server.java": [
          "package league;",
          "import io.javalin.Javalin;",
          "public class Server {",
          "    void wire(Javalin app, Table table) {",
          "        app.after(\"/x\", ctx -> table.save());",
          "        Javalin.create(config -> table.save());",
          "    }",
          "}",
          "",
        ].join("\n"),
        "league/Garage.java": [
          "package league;",
          "public class Garage {",
          "    void wire(Table app, Table table) {",
          "        app.after(\"/x\", ctx -> table.save());",
          "    }",
          "}",
          "",
        ].join("\n"),
      },
      "java",
    );
    expect(argCalls(analyses.find((a) => a.filePath === "league/Server.java")!, "wire")).toEqual([]);
    // The same shape on a project-typed receiver keeps its fact.
    expect(argCalls(analyses.find((a) => a.filePath === "league/Garage.java")!, "wire")).toEqual(["app.after"]);
  });

  it("Kotlin: routing { post(...) { } } states nothing, while a project function taking a lambda still links", async () => {
    const analyses = await analyzeAll(
      {
        "league/Table.kt": ["package league", "class Table { fun save() { } }", ""].join("\n"),
        "league/Routes.kt": [
          "package league",
          "import io.ktor.server.routing.routing",
          "import io.ktor.server.routing.post",
          "fun register(r: () -> Unit) { r() }",
          "fun Table.wire() {",
          "    routing {",
          "        post(\"/x\", { save() })",
          "    }",
          "    register { save() }",
          "}",
          "",
        ].join("\n"),
        "league/Decoy.kt": ["package league", "class Decoy { fun save() { } }", ""].join("\n"),
        "league/Own.kt": [
          "package league",
          "fun post(path: String, r: () -> Unit) { r() }",
          "fun Table.own() { post(\"/y\", { save() }) }",
          "",
        ].join("\n"),
      },
      "kotlin",
    );
    expect(argCalls(analyses.find((a) => a.filePath === "league/Routes.kt")!, "wire")).toEqual(["register"]);
    // A `post` the file declares (no library import) is the project's.
    expect(argCalls(analyses.find((a) => a.filePath === "league/Own.kt")!, "own")).toEqual(["post"]);
  });

  it("a wildcard import never makes a same-file class or a same-package function a library's (real-repo FP)", async () => {
    const analyses = await analyzeAll(
      {
        "league/Table.kt": ["package league", "class Table { fun save() { } }", "fun register(r: () -> Unit) { r() }", ""].join("\n"),
        "league/Fetcher.kt": [
          "package league",
          "import kotlinx.coroutines.*",
          "class Fetcher(private val table: Table) {",
          "    private fun onComplete() { table.save() }",
          "    fun start() {",
          "        val cb = Callback(::onComplete)",
          "        register { table.save() }",
          "    }",
          "    private class Callback(private val done: () -> Unit) { fun fire() { done() } }",
          "}",
          "",
        ].join("\n"),
        "league/Decoy.kt": ["package league", "class Decoy { fun onComplete() { } }", ""].join("\n"),
      },
      "kotlin",
    );
    expect(argCalls(analyses.find((a) => a.filePath === "league/Fetcher.kt")!, "start").sort()).toEqual(["Callback", "register"]);
  });

  it("Java: a wildcard static import of a class that extends another leaves bare calls to the project", async () => {
    const analyses = await analyzeAll(
      {
        "league/Base.java": ["package league;", "public class Base {", "    protected void later(Runnable r) { r.run(); }", "}", ""].join("\n"),
        "league/Match.java": [
          "package league;",
          "import static org.mockito.Mockito.*;",
          "public class Match extends Base {",
          "    void kickOff() { }",
          "    void wire() { later(() -> kickOff()); }",
          "}",
          "",
        ].join("\n"),
      },
      "java",
    );
    expect(argCalls(analyses.find((a) => a.filePath === "league/Match.java")!, "wire")).toEqual(["later"]);
  });
});

describe("a held lambda's cap counts project functions only (real-repo FP)", () => {
  const javaFiles = (body: string) => ({
    "league/Club.java": ["package league;", "public class Club { public void save() { } }", ""].join("\n"),
    "league/Match.java": [
      "package league;",
      "import static org.leaguelib.Stats.tally;",
      "import java.util.*;",
      "public class Match {",
      "    private final Object audit = null;",
      "    void kickOff() { }",
      "    void closeMatch() { }",
      "    void refreshTable() { }",
      "    void sendOff() { }",
      "    void swap() { }",
      `    void run1(Club club, List<Club> list) { Runnable m = () -> { ${body} }; m.run(); }`,
      "}",
      "",
    ].join("\n"),
    "league/Decoy.java": ["package league;", "public class Decoy { public void run() { } public void kickOff() { } public void closeMatch() { } public void refreshTable() { } public void sendOff() { } public void tally() { } }", ""].join("\n"),
  });
  const kotlinFiles = (body: string) => ({
    "league/Club.kt": ["package league", "class Club { fun save() {} }", ""].join("\n"),
    "league/Match.kt": [
      "package league",
      "import org.leaguelib.tally",
      "class Match {",
      "    fun kickOff() {}",
      "    fun closeMatch() {}",
      "    fun refreshTable() {}",
      "    fun sendOff() {}",
      "    fun swap() {}",
      `    fun run1(club: Club, list: List<Club>) { val m = { ${body} }; m() }`,
      "}",
      "",
    ].join("\n"),
    "league/Decoy.kt": ["package league", "class Decoy { fun invoke() {}; fun kickOff() {}; fun closeMatch() {}; fun refreshTable() {}; fun sendOff() {}; fun tally() {}; fun m() {} }", ""].join("\n"),
  });

  it("Java: four project functions beside library and unknown names link all four", async () => {
    const out = links(await analyzeAll(javaFiles("kickOff(); closeMatch(); tally(1); list.stream(); audit.record(); refreshTable(); club.save(); log.info(\"x\");"), "java"), "value-flow");
    expect(out).toEqual([
      "Match.run1: m.run -> Club.java::Club.save",
      "Match.run1: m.run -> Match.java::Match.closeMatch",
      "Match.run1: m.run -> Match.java::Match.kickOff",
      "Match.run1: m.run -> Match.java::Match.refreshTable",
    ]);
  });

  it("Java: five project functions link nothing", async () => {
    const out = links(await analyzeAll(javaFiles("kickOff(); closeMatch(); refreshTable(); sendOff(); swap(); tally(1);"), "java"), "value-flow");
    expect(out).toEqual([]);
  });

  it("Kotlin: four project functions beside library and unknown names link all four", async () => {
    const out = links(await analyzeAll(kotlinFiles("kickOff(); closeMatch(); tally(1); list.stream(); audit.record(); refreshTable(); club.save(); log.info(\"x\")"), "kotlin"), "value-flow");
    expect(out).toEqual([
      "Match.run1: m -> Club.kt::Club.save",
      "Match.run1: m -> Match.kt::Match.closeMatch",
      "Match.run1: m -> Match.kt::Match.kickOff",
      "Match.run1: m -> Match.kt::Match.refreshTable",
    ]);
  });

  it("Kotlin: five project functions link nothing", async () => {
    const out = links(await analyzeAll(kotlinFiles("kickOff(); closeMatch(); refreshTable(); sendOff(); swap(); tally(1)"), "kotlin"), "value-flow");
    expect(out).toEqual([]);
  });
});
