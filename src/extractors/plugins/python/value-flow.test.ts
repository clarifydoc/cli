/**
 * Python value flow: a function held in a local, a parameter, a `self` field, a list, a dict or a return value
 * reaches the call that runs it — through the real per-file pipeline and the linker. Every shape has a decoy
 * (a same-named function, field or an unrelated callable) that must stay unlinked.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "py-value-flow-"));
  const out = await mkdtemp(join(tmpdir(), "py-value-flow-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "python" },
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

/** The `value-flow` links, as `file::source@line call -> target`. */
function flowLinks(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceFile}::${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

const MATCH = [
  "from functools import partial",
  "",
  "def save_match(m):",
  "    return m",
  "",
  "def drop_match(m):",
  "    return m",
  "",
  "def cb(m):",
  "    return m",
  "",
  "def run_with(cb, m):",
  "    cb(m)",
  "",
  "def via_local():",
  "    h = save_match",
  "    g = h",
  "    run_with(g, 1)",
  "",
  "def make_handler():",
  "    return save_match",
  "",
  "def via_factory():",
  "    f = make_handler()",
  "    f(1)",
  "",
  "def via_partial():",
  "    p = partial(save_match, 1)",
  "    p()",
  "",
].join("\n");

describe("Python value flow", () => {
  it("follows a local copied and handed to a wrapper, a factory's return and functools.partial", async () => {
    const links = flowLinks(await analyzeAll({ "match.py": MATCH }));
    expect(links).toContain("match.py::run_with@13 cb -> match.py::save_match");
    expect(links).toContain("match.py::via_factory@25 f -> match.py::save_match");
    expect(links).toContain("match.py::via_partial@29 p -> match.py::save_match");
    // The parameter is not the module function of the same name, and the decoy is never handed on.
    expect(links.some((l) => l.includes("-> match.py::cb") || l.includes("-> match.py::drop_match"))).toBe(false);
  });

  it("follows a function stored in a self field, a bound method stored in one, and keeps a same-named decoy out", async () => {
    const links = flowLinks(await analyzeAll({
      "referee.py": [
        "def stop_play():",
        "    pass",
        "",
        "def on_whistle():",
        "    pass",
        "",
        "class Referee:",
        "    def __init__(self, on_whistle):",
        "        self.on_whistle = on_whistle",
        "        self.on_card = None",
        "",
        "    def arm(self):",
        "        self.on_card = self.show_card",
        "",
        "    def show_card(self):",
        "        pass",
        "",
        "    def blow(self):",
        "        self.on_whistle()",
        "        self.on_card()",
        "",
        "class Linesman:",
        "    def __init__(self):",
        "        self.on_whistle = None",
        "",
        "    def flag(self):",
        "        self.on_whistle()",
        "",
        "def start():",
        "    Referee(stop_play)",
        "",
      ].join("\n"),
    }));
    expect(links).toContain("referee.py::Referee.blow@19 self.on_whistle -> referee.py::stop_play");
    expect(links).toContain("referee.py::Referee.blow@20 self.on_card -> referee.py::Referee.show_card");
    // The Linesman's field holds nothing, and the module function `on_whistle` is not what it calls.
    expect(links.some((l) => l.includes("Linesman"))).toBe(false);
    expect(links.some((l) => l.includes("-> referee.py::on_whistle"))).toBe(false);
  });

  it("follows a list of callbacks iterated, and a dict of handlers by literal key or by variable", async () => {
    const links = flowLinks(await analyzeAll({
      "bench.py": [
        "def substitute():",
        "    pass",
        "",
        "def send_off():",
        "    pass",
        "",
        "def cheer():",
        "    pass",
        "",
        "def boo():",
        "    pass",
        "",
        "ACTIONS = {'sub': substitute, 'red': send_off}",
        "",
        "class Crowd:",
        "    def __init__(self):",
        "        self.listeners = []",
        "        self.listeners.append(cheer)",
        "",
        "    def roar(self):",
        "        for fn in self.listeners:",
        "            fn()",
        "",
        "def by_key():",
        "    ACTIONS['sub']()",
        "",
        "def by_variable(kind):",
        "    ACTIONS[kind]()",
        "",
        "def handlers_local():",
        "    handlers = []",
        "    handlers.append(boo)",
        "    for h in handlers:",
        "        h()",
        "",
      ].join("\n"),
    }));
    expect(links).toContain("bench.py::Crowd.roar@22 fn -> bench.py::cheer");
    expect(links).toContain("bench.py::by_key@25 ACTIONS['sub'] -> bench.py::substitute");
    expect(links.filter((l) => l.includes("bench.py::by_key@")).some((l) => l.endsWith("send_off"))).toBe(false);
    expect(links).toContain("bench.py::by_variable@28 ACTIONS[kind] -> bench.py::substitute");
    expect(links).toContain("bench.py::by_variable@28 ACTIONS[kind] -> bench.py::send_off");
    expect(links).toContain("bench.py::handlers_local@34 h -> bench.py::boo");
    // `cheer` never reaches the local list, nor `boo` the crowd's.
    expect(links.some((l) => l.startsWith("bench.py::handlers_local") && l.endsWith("cheer"))).toBe(false);
    expect(links.some((l) => l.startsWith("bench.py::Crowd.roar") && l.endsWith("boo"))).toBe(false);
  });

  it("follows a module-level binding and a `global` assignment into the functions that call them", async () => {
    const links = flowLinks(await analyzeAll({
      "hooks.py": [
        "def kick_off():",
        "    pass",
        "",
        "def full_time():",
        "    pass",
        "",
        "start_hook = kick_off",
        "end_hook = None",
        "",
        "def install():",
        "    global end_hook",
        "    end_hook = full_time",
        "",
        "def run_all():",
        "    start_hook()",
        "    end_hook()",
        "",
      ].join("\n"),
    }));
    expect(links).toContain("hooks.py::run_all@15 start_hook -> hooks.py::kick_off");
    expect(links).toContain("hooks.py::run_all@16 end_hook -> hooks.py::full_time");
  });

  it("carries a function across files through an import", async () => {
    const links = flowLinks(await analyzeAll({
      "runner.py": ["def run_with(cb):", "    cb()", ""].join("\n"),
      "plays.py": ["from runner import run_with", "", "def corner():", "    pass", "", "def throw_in():", "    pass", "", "def go():", "    run_with(corner)", ""].join("\n"),
    }));
    expect(links).toContain("runner.py::run_with@2 cb -> plays.py::corner");
    expect(links.some((l) => l.endsWith("throw_in"))).toBe(false);
  });

  it("treats a lambda bound to a module name as a function: its calls are its own and passing it reaches the caller", async () => {
    const links = buildSymbolLinks(await analyzeAll({
      "ready.py": [
        "def refresh():",
        "    pass",
        "",
        "def other():",
        "    pass",
        "",
        "on_ready = lambda: refresh()",
        "",
        "def fire(cb):",
        "    cb()",
        "",
        "def go():",
        "    fire(on_ready)",
        "",
      ].join("\n"),
    }));
    expect(links.some((l) => l.sourceSymbol === "on_ready" && l.targetSymbol === "refresh")).toBe(true);
    expect(links.some((l) => l.strategy === "value-flow" && l.sourceSymbol === "fire" && l.targetSymbol === "on_ready")).toBe(true);
    expect(links.some((l) => l.strategy === "value-flow" && l.targetSymbol === "other")).toBe(false);
  });

  it("follows a closure's read of its parent's local, `+=` onto a list, a returned tuple and a `.get` on a table", async () => {
    const links = flowLinks(await analyzeAll({
      "closures.py": [
        "def save_match():",
        "    pass",
        "",
        "def drop_match():",
        "    pass",
        "",
        "def run_with(cb):",
        "    cb()",
        "",
        "def outer():",
        "    h = save_match",
        "    def inner():",
        "        run_with(h)",
        "    inner()",
        "",
        "def pair():",
        "    return save_match, 1",
        "",
        "def use_pair():",
        "    f, n = pair()",
        "    f()",
        "",
        "def grow():",
        "    cbs = []",
        "    cbs += [save_match]",
        "    for cb in cbs:",
        "        cb()",
        "",
        "TABLE = {'a': save_match}",
        "",
        "def lookup(k):",
        "    TABLE.get(k)()",
        "",
      ].join("\n"),
    }));
    expect(links).toContain("closures.py::run_with@8 cb -> closures.py::save_match");
    expect(links).toContain("closures.py::use_pair@21 f -> closures.py::save_match");
    expect(links).toContain("closures.py::grow@27 cb -> closures.py::save_match");
    expect(links.some((l) => l.endsWith("drop_match"))).toBe(false);
    expect(links.some((l) => l.startsWith("closures.py::lookup") && l.endsWith("save_match"))).toBe(true);
  });

  it("does not seed a `global` assignment from a parameter of the function", async () => {
    const links = flowLinks(await analyzeAll({
      "global_hook.py": [
        "def cb():",
        "    pass",
        "",
        "HOOK = None",
        "",
        "def set_hook(cb):",
        "    global HOOK",
        "    HOOK = cb",
        "",
        "def fire():",
        "    HOOK()",
        "",
      ].join("\n"),
    }));
    expect(links.some((l) => l.includes("::fire@"))).toBe(false);
  });

  it("keeps a test's fixture parameter linked to the fixture, while a helper's parameter holds what callers pass", async () => {
    const analyses = await analyzeAll({
      "test_league.py": [
        "import pytest",
        "",
        "@pytest.fixture",
        "def use_club():",
        "    pass",
        "",
        "def test_signing(use_club):",
        "    use_club()",
        "",
      ].join("\n"),
    });
    const links = buildSymbolLinks(analyses);
    expect(links.some((l) => l.sourceSymbol === "test_signing" && l.targetSymbol === "use_club")).toBe(true);
  });

  it("does not take a lambda parameter for the enclosing local of the same name", async () => {
    const links = flowLinks(await analyzeAll({
      "shadow.py": [
        "def save_match():",
        "    pass",
        "",
        "def run(items):",
        "    cb = save_match",
        "    return [(lambda cb: cb())(x) for x in items]",
        "",
      ].join("\n"),
    }));
    expect(links.some((l) => l.includes("::run@"))).toBe(false);
  });

  describe("lambdas written inside a function", () => {
    const DECOY = {
      "decoy.py": [
        "def save_club():",
        "    pass",
        "",
        "def kick_off():",
        "    pass",
        "",
        "def close_match():",
        "    pass",
        "",
        "def refresh_table():",
        "    pass",
        "",
      ].join("\n"),
    };

    it("follows a local lambda handed to a wrapper that invokes its parameter", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "club.py": [
          "def save_club():",
          "    pass",
          "",
          "def run(cb):",
          "    cb()",
          "",
          "def go():",
          "    h = lambda: save_club()",
          "    run(h)",
          "    run(lambda x: save_club())",
          "",
        ].join("\n"),
      }));
      expect(links).toContain("club.py::run@5 cb -> club.py::save_club");
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("follows self.cb = lambda invoked in another method, and a bound method called inside it", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "table.py": [
          "def refresh_table():",
          "    pass",
          "",
          "class Table:",
          "    def __init__(self):",
          "        self.on_done = lambda: refresh_table()",
          "        self.on_save = lambda: self.persist()",
          "",
          "    def persist(self):",
          "        pass",
          "",
          "    def finish(self):",
          "        self.on_done()",
          "        self.on_save()",
          "",
        ].join("\n"),
      }));
      expect(links).toContain("table.py::Table.finish@13 self.on_done -> table.py::refresh_table");
      expect(links).toContain("table.py::Table.finish@14 self.on_save -> table.py::Table.persist");
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("follows a dict of lambdas invoked by key", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "plays.py": [
          "def kick_off():",
          "    pass",
          "",
          "def run(name):",
          "    handlers = {\"a\": lambda: kick_off()}",
          "    handlers[\"a\"]()",
          "",
        ].join("\n"),
      }));
      expect(links.some((l) => l.includes("-> plays.py::kick_off"))).toBe(true);
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("follows a factory returning a lambda invoked by the caller", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "factory.py": [
          "def close_match():",
          "    pass",
          "",
          "def make():",
          "    return lambda: close_match()",
          "",
          "def use():",
          "    f = make()",
          "    f()",
          "",
        ].join("\n"),
      }));
      expect(links).toContain("factory.py::use@9 f -> factory.py::close_match");
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("states nothing for a lambda calling more than four names, a call on its own parameter or on a name it binds", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "many.py": [
          "def a(): pass",
          "def b(): pass",
          "def c(): pass",
          "def d(): pass",
          "def e(): pass",
          "def club(): pass",
          "def f(): pass",
          "",
          "def run_many(cb):",
          "    cb()",
          "",
          "def run_param(cb):",
          "    cb()",
          "",
          "def run_bound(cb):",
          "    cb()",
          "",
          "def go(handlers):",
          "    run_many(lambda: (a(), b(), c(), d(), e()))",
          "    run_param(lambda club: club())",
          "    run_bound(lambda: [f() for f in handlers])",
          "",
        ].join("\n"),
      }));
      expect(links.filter((l) => l.startsWith("many.py::run_"))).toEqual([]);
    });

    it("links four project functions when the body also calls names that resolve to no project function", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "mixed.py": [
          "def a(): pass",
          "def b(): pass",
          "def c(): pass",
          "def d(): pass",
          "",
          "def run(cb):",
          "    cb()",
          "",
          "def go(thing):",
          "    run(lambda: (a(), b(), thing.x(), c(), unknown_one(), d(), unknown_two()))",
          "",
        ].join("\n"),
      }));
      expect(links.filter((l) => l.startsWith("mixed.py::run"))).toEqual([
        "mixed.py::run@7 cb -> mixed.py::a",
        "mixed.py::run@7 cb -> mixed.py::b",
        "mixed.py::run@7 cb -> mixed.py::c",
        "mixed.py::run@7 cb -> mixed.py::d",
      ]);
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("links nothing when five project functions are called, whatever else the body names", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "five.py": [
          "def a(): pass",
          "def b(): pass",
          "def c(): pass",
          "def d(): pass",
          "def e(): pass",
          "",
          "def run(cb):",
          "    cb()",
          "",
          "def go(thing):",
          "    run(lambda: (a(), b(), thing.x(), c(), unknown_one(), d(), e()))",
          "",
        ].join("\n"),
      }));
      expect(links.filter((l) => l.startsWith("five.py::run"))).toEqual([]);
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    it("keeps four names", async () => {
      const links = flowLinks(await analyzeAll({
        "four.py": [
          "def a(): pass",
          "def b(): pass",
          "def c(): pass",
          "def d(): pass",
          "",
          "def run(cb):",
          "    cb()",
          "",
          "def go():",
          "    run(lambda: (a(), b(), c(), d()))",
          "",
        ].join("\n"),
      }));
      expect(links).toHaveLength(4);
    });

    it("copies from a held name the lambda calls", async () => {
      const links = flowLinks(await analyzeAll({
        ...DECOY,
        "held.py": [
          "def refresh_table():",
          "    pass",
          "",
          "def run(cb):",
          "    cb()",
          "",
          "def go(on_done):",
          "    run(lambda: on_done())",
          "",
          "def start():",
          "    go(refresh_table)",
          "",
        ].join("\n"),
      }));
      expect(links).toContain("held.py::run@5 cb -> held.py::refresh_table");
      expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
    });

    describe("library calls in a lambda", () => {
      const LIB = [
        "import json",
        "import logging",
        "import time",
        "from json import dumps",
        "",
        "def save_club():",
        "    pass",
        "",
        "def kick_off():",
        "    pass",
        "",
        "def run(cb):",
        "    cb()",
        "",
      ];
      it("does not count json.dumps, logging.info and time.sleep toward the four-name cap", async () => {
        const links = flowLinks(await analyzeAll({
          ...DECOY,
          "lib.py": [
            ...LIB,
            "def go():",
            "    run(lambda: (json.dumps({}), logging.info('x'), time.sleep(1), save_club(), kick_off()))",
            "",
          ].join("\n"),
        }));
        expect(links).toContain("lib.py::run@13 cb -> lib.py::save_club");
        expect(links).toContain("lib.py::run@13 cb -> lib.py::kick_off");
        expect(links.some((l) => l.includes("decoy.py"))).toBe(false);
      });

      it("does not count a bare name imported from the standard library", async () => {
        const links = flowLinks(await analyzeAll({
          ...DECOY,
          "lib.py": [
            ...LIB,
            "def go():",
            "    run(lambda: (dumps({}), time.sleep(1), logging.info('x'), json.loads('1'), save_club(), kick_off()))",
            "",
          ].join("\n"),
        }));
        expect(links).toContain("lib.py::run@13 cb -> lib.py::save_club");
        expect(links).toContain("lib.py::run@13 cb -> lib.py::kick_off");
      });

      it("still counts a project module imported relatively or as a project package toward the cap", async () => {
        const files = (names: string) => ({
          ...DECOY,
          "league/__init__.py": "def a():\n    pass\n\ndef c():\n    pass\n",
          "league/table.py": "def refresh_table():\n    pass\n\ndef b():\n    pass\n\ndef d():\n    pass\n",
          "lib.py": [
            "from . import league",
            "from league import table",
            "",
            "def save_club():",
            "    pass",
            "",
            "def run(cb):",
            "    cb()",
            "",
            "def go():",
            `    run(lambda: (${names}))`,
            "",
          ].join("\n"),
        });
        // Four project functions plus a fifth: core counts what the names resolve to (a library's would not count), so the cap is passed.
        expect(flowLinks(await analyzeAll(files("league.a(), table.b(), league.c(), table.d(), save_club()")))).toEqual([]);
        expect(flowLinks(await analyzeAll(files("league.a(), table.b(), save_club()")))).toContain("lib.py::run@8 cb -> lib.py::save_club");
      });
    });
  });
});

describe("Python value flow: a factory returns its own nested function (real-repo FP)", () => {
  it("links the call of a factory's result to the function nested in that factory, not a namesake in another", async () => {
    const analyses = await analyzeAll({
        "signals.py": [
          "def save_club():",
          "    pass",
          "",
          "def make_save_handler():",
          "    def _handler(club):",
          "        save_club()",
          "    return _handler",
          "",
          "def make_transfer_handler():",
          "    def _handler(club):",
          "        save_club()",
          "    return _handler",
          "",
          "def fire():",
          "    handler = make_transfer_handler()",
          "    handler(1)",
          "",
        ].join("\n"),
    });
    const fire = buildSymbolLinks(analyses).filter((l) => l.strategy === "value-flow" && l.sourceSymbol === "fire");
    // The `_handler` nested in make_transfer_handler (line 10), never make_save_handler's (line 5).
    expect(fire.map((l) => `${l.callName} -> ${l.targetSymbol}:${l.targetLine}`)).toEqual(["handler -> _handler:10"]);
  });
});
