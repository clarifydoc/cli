/**
 * PHP value flow: a function value through locals, parameters, properties, returns and handler lists to the
 * call that runs it, through the real per-file pipeline and the linker. Every case keeps a same-named decoy.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "php-vf-"));
  const out = await mkdtemp(join(tmpdir(), "php-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "php" },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** The value-flow links as `source@line call -> target`. */
async function flow(files: Record<string, string>): Promise<string[]> {
  const analyses = await analyzeAll(files);
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

// Decoys: a same-named function in another file, which no name tier may pick for a held value.
const decoys = ["<?php", "function handler() {}", "function cb() {}", "function onSave() {}", "function save() {}", "function saveClub() {}", "function refreshTable() {}", "function kickOff() {}", "function closeMatch() {}", "class Season { public static function close() {} public function save() {} }", ""].join("\n");

describe("PHP value flow: the matrix", () => {
  it("a string callable in a local, copied, handed to a wrapper and invoked there", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Runner.php": ["<?php", "function run($cb) {", "    $handler = $cb;", "    $handler(1);", "}", ""].join("\n"),
      "src/Club.php": ["<?php", "require_once __DIR__ . '/Runner.php';", "function saveClub($c) {}", "function boot() {", "    $h = 'saveClub';", "    $g = $h;", "    run($g);", "}", ""].join("\n"),
    });
    expect(links).toEqual(["run@4 handler -> src/Club.php::saveClub"]);
  });

  it("a method callable stored in a property and run in another method", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "class Club {", "    private $onSave;", "    public function setup() {", "        $this->onSave = [$this, 'persist'];", "    }",
        "    public function fire() {", "        ($this->onSave)();", "        call_user_func($this->onSave, 1);", "    }", "    public function persist() {}", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([
      "Club.fire@8 this.onSave -> src/Club.php::Club.persist",
      "Club.fire@9 call_user_func -> src/Club.php::Club.persist",
    ]);
  });

  it("a callable returned from a factory and invoked by the caller", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function saveClub() {}", "function makeHandler() {", "    return 'saveClub';", "}",
        "function boot() {", "    $cb = makeHandler();", "    $cb();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["boot@8 cb -> src/Club.php::saveClub"]);
  });

  it("a map of handlers invoked by key and by element", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function saveClub() {}", "function retireClub() {}", "function boot($k) {",
        "    $handlers = ['save' => 'saveClub', 'retire' => 'retireClub'];",
        "    $handlers['save']();", "    $handlers[k]();", "    foreach ($handlers as $fn) { $fn(); }", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([
      "boot@6 handlers[save] -> src/Club.php::saveClub",
      "boot@7 handlers[k] -> src/Club.php::retireClub",
      "boot@7 handlers[k] -> src/Club.php::saveClub",
      "boot@8 fn -> src/Club.php::retireClub",
      "boot@8 fn -> src/Club.php::saveClub",
    ]);
  });

  it("a list property of handlers filled by append and run by element", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Bus.php": [
        "<?php", "class Bus {", "    private $listeners = [];", "    public function on() {", "        $this->listeners[] = [$this, 'persist'];", "    }",
        "    public function emit() {", "        foreach ($this->listeners as $l) { $l(); }", "    }", "    public function persist() {}", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["Bus.emit@8 l -> src/Bus.php::Bus.persist"]);
  });
});

describe("PHP value flow: callable shapes", () => {
  it("first-class callable syntax, static and instance", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "class Club {", "    public static function save() {}", "    public function retire() {}",
        "    public function go() {", "        $a = Club::save(...);", "        $b = $this->retire(...);", "        $a();", "        $b();", "    }", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["Club.go@8 a -> src/Club.php::Club.save", "Club.go@9 b -> src/Club.php::Club.retire"]);
  });

  it("Closure::fromCallable, [Club::class, 'save'] and 'Club::save'", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "class Club {", "    public static function save() {}", "    public function retire() {}", "}", "",
      ].join("\n"),
      "src/Boot.php": [
        "<?php", "function boot() {", "    $a = Closure::fromCallable([Club::class, 'save']);", "    $b = 'Club::save';", "    $a();", "    $b();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["boot@5 a -> src/Club.php::Club.save", "boot@6 b -> src/Club.php::Club.save"]);
  });

  it("call_user_func_array and array_map run the callback argument", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function saveClub() {}", "function boot($xs) {", "    $cb = 'saveClub';", "    call_user_func_array($cb, [1]);", "    array_map($cb, $xs);", "    array_walk($xs, 'saveClub');", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([
      "boot@5 call_user_func_array -> src/Club.php::saveClub",
      "boot@6 array_map -> src/Club.php::saveClub",
      "boot@7 array_walk -> src/Club.php::saveClub",
    ]);
  });
});

describe("PHP value flow: decoys", () => {
  it("a class with its own __invoke-free call and a namesake function link nothing for a variable call", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "class Club {", "    public function handler() {}", "    public function go($handler) {", "        $handler();", "        $this->handler();", "    }", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([]);
  });

  it("a string that names no function, and a closure, are no values", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": ["<?php", "function boot() {", "    $a = 'active';", "    $b = function () { return 1; };", "    $a();", "    $b();", "}", ""].join("\n"),
    });
    expect(links).toEqual([]);
  });

  it("a callback hidden by a closure's own parameter is not the outer variable", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": ["<?php", "function saveClub() {}", "function boot($xs) {", "    $cb = 'saveClub';", "    array_map(function ($cb) { $cb(); }, $xs);", "}", ""].join("\n"),
    });
    expect(links).toEqual([]);
  });
});

describe("PHP value flow: closures held in a value", () => {
  it("a local arrow function handed to a wrapper that runs its parameter", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Runner.php": ["<?php", "function run($cb) {", "    $cb();", "}", ""].join("\n"),
      "src/Club.php": ["<?php", "require_once __DIR__ . '/Runner.php';", "function refreshTable() {}", "function boot() {", "    $cb = fn() => refreshTable();", "    run($cb);", "}", ""].join("\n"),
    });
    expect(links).toEqual(["run@3 cb -> src/Club.php::refreshTable"]);
  });

  it("a closure written in the argument list, and its $this call", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "class Club {", "    public function save() {}", "    public function boot() {", "        $this->run(function () { $this->save(); });", "    }",
        "    public function run($cb) {", "        $cb();", "    }", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["Club.run@8 cb -> src/Club.php::Club.save"]);
  });

  it("a property holding a closure, run in another method; a static call keeps its class", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Season.php": ["<?php", "class Season {", "    public static function close() {}", "}", ""].join("\n"),
      "src/Club.php": [
        "<?php", "class Club {", "    private $onDone;", "    public function setup() {", "        $this->onDone = fn() => Season::close();", "    }",
        "    public function finish() {", "        ($this->onDone)();", "    }", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["Club.finish@8 this.onDone -> src/Season.php::Season.close"]);
  });

  it("an array of closures run by key", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function kickOff() {}", "function whistle() {}", "function boot($key) {",
        "    $actions = ['a' => fn() => kickOff(), 'b' => function () { whistle(); }];", "    $actions['a']();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["boot@6 actions[a] -> src/Club.php::kickOff"]);
  });

  it("a factory returning a closure, run by the caller", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function closeMatch() {}", "function makeHandler() {", "    return fn() => closeMatch();", "}",
        "function boot() {", "    $cb = makeHandler();", "    $cb();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["boot@8 cb -> src/Club.php::closeMatch"]);
  });

  it("a closure that runs a held value hands on what it holds", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function saveClub() {}", "function boot() {", "    $onDone = 'saveClub';", "    $cb = fn() => $onDone();", "    $cb();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual(["boot@5 onDone -> src/Club.php::saveClub", "boot@6 cb -> src/Club.php::saveClub"]);
  });

  it("more than four calls state nothing", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function a1() {}", "function a2() {}", "function a3() {}", "function a4() {}", "function a5() {}",
        "function boot() {", "    $cb = function () { a1(); a2(); a3(); a4(); a5(); };", "    $cb();", "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([]);
  });

  it("a call on the closure's own parameter, a builtin and an untyped receiver state nothing", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": [
        "<?php", "function boot($player) {",
        "    $a = fn($club) => $club->save();", "    $a(1);",
        "    $b = fn($x) => strlen($x);", "    $b(1);",
        "    $c = fn() => $player->save();", "    $c();",
        "}", "",
      ].join("\n"),
    });
    expect(links).toEqual([]);
  });

  it("a closure given to array_map is a block, not a value", async () => {
    const links = await flow({
      "decoys.php": decoys,
      "src/Club.php": ["<?php", "function refreshTable() {}", "function boot($xs) {", "    array_map(fn($x) => refreshTable(), $xs);", "}", ""].join("\n"),
    });
    expect(links).toEqual([]);
  });
});
