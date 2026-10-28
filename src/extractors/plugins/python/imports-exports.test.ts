import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonImportExportExtractor } from "./imports-exports.js";

async function imports(src: string) {
  const tree = await parseSource(src, "python" as never, "a.py");
  return new PythonImportExportExtractor()
    .extractImports(tree, src)
    .map((i) => ({ source: i.source, specifiers: i.specifiers, isType: i.isType, line: i.line }));
}

describe("Python imports", () => {
  it("finds a function-local import, the usual way to break an import cycle", async () => {
    expect(await imports(`
from pathlib import Path

class CallGraphAnalyzer:
    def analyze(self, files):
        from scouting.core.analysis_limits import reset_global_tracker
        reset_global_tracker()
        for f in files:
            if f.lang == "python":
                from scouting.analyzers.python import analyze_python_file
                analyze_python_file(f)

@cached
def helper():
    import json
    return json
`)).toEqual([
      { source: "pathlib", specifiers: ["Path"], isType: false, line: 2 },
      { source: "scouting.core.analysis_limits", specifiers: ["reset_global_tracker"], isType: false, line: 6 },
      { source: "scouting.analyzers.python", specifiers: ["analyze_python_file"], isType: false, line: 10 },
      { source: "json", specifiers: ["json"], isType: false, line: 15 },
    ]);
  });

  it("finds both arms of a try/except ImportError fallback", async () => {
    expect(await imports(`
try:
    import ujson as json
except ImportError:
    import json
finally:
    from x import y
`)).toEqual([
      // The module is ujson; `json` is only the name it is bound to.
      { source: "ujson", specifiers: ["json"], isType: false, line: 3 },
      { source: "json", specifiers: ["json"], isType: false, line: 5 },
      { source: "x", specifiers: ["y"], isType: false, line: 7 },
    ]);
  });

  it("keeps the dotted module of an aliased import, and every module of one statement", async () => {
    expect(await imports(`import app.models as m, os, numpy as np`)).toEqual([
      { source: "app.models", specifiers: ["m"], isType: false, line: 1 },
      { source: "os", specifiers: ["os"], isType: false, line: 1 },
      { source: "numpy", specifiers: ["np"], isType: false, line: 1 },
    ]);
  });

  it("marks imports under a TYPE_CHECKING guard as type-only, and only that branch", async () => {
    expect(await imports(`
from typing import TYPE_CHECKING
import typing

if TYPE_CHECKING:
    from app.models import Player
elif FEATURE:
    from app.feature import flag
else:
    from app.runtime import Runtime

if typing.TYPE_CHECKING:
    from app.db import Session
`)).toEqual([
      { source: "typing", specifiers: ["TYPE_CHECKING"], isType: false, line: 2 },
      { source: "typing", specifiers: ["typing"], isType: false, line: 3 },
      { source: "app.models", specifiers: ["Player"], isType: true, line: 6 },
      { source: "app.feature", specifiers: ["flag"], isType: false, line: 8 },
      { source: "app.runtime", specifiers: ["Runtime"], isType: false, line: 10 },
      { source: "app.db", specifiers: ["Session"], isType: true, line: 13 },
    ]);
  });

  it("does not mistake an import-shaped string or name for an import", async () => {
    expect(await imports(`
def f():
    s = "from os import path"
    return importlib.import_module("os")
`)).toEqual([]);
  });
});

describe("python package re-exports", () => {
  it("records what a module-level relative or wildcard import forwards", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { PythonImportExportExtractor } = await import("./imports-exports.js");
    const src = `from .dependencies import *
from .player import Player as Club, Group
from league.schema import *
from typing import Any
def helper():
    from .late import x
`;
    const tree = await parseSource(src, "python" as any, "pkg/__init__.py");
    const exports = new PythonImportExportExtractor().extractExports(tree, src).filter((e) => e.kind === "re-export");
    expect(exports.map((e) => [e.name, e.source, e.sourceName])).toEqual([
      ["*", ".dependencies", undefined],
      ["Club", ".player", "Player"],
      ["Group", ".player", undefined],
      ["*", "league.schema", undefined],
    ]);
  });

  it("forwards a package __init__'s absolute imports of its own tree", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { PythonImportExportExtractor } = await import("./imports-exports.js");
    const src = `from app.services.player import PlayerService
from app.services.car import CarService as Cars
from typing import Any
`;
    const reExports = async (path: string) => {
      const tree = await parseSource(src, "python" as any, path);
      return new PythonImportExportExtractor().extractExports(tree, src, path)
        .filter((e) => e.kind === "re-export").map((e) => [e.name, e.source, e.sourceName]);
    };
    expect(await reExports("src/app/services/__init__.py")).toEqual([
      ["PlayerService", "app.services.player", undefined],
      ["Cars", "app.services.car", "CarService"],
    ]);
    // Any other module's absolute imports are its dependencies.
    expect(await reExports("src/app/services/api.py")).toEqual([]);
  });

  it("narrows a module's exports to a literal __all__", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { PythonImportExportExtractor } = await import("./imports-exports.js");
    const exportsOf = async (src: string) => {
      const tree = await parseSource(src, "python" as any, "pkg/b.py");
      return new PythonImportExportExtractor().extractExports(tree, src, "pkg/b.py").map((e) => e.name);
    };
    const body = "class Foo:\n    pass\n\ndef helper():\n    pass\n";
    expect(await exportsOf(`__all__ = ["Foo"]\n${body}`)).toEqual(["Foo"]);
    expect(await exportsOf(`__all__ = ("Foo",)\n__all__ += ["helper"]\n${body}`)).toEqual(["Foo", "helper"]);
    // Not a literal: the full list is unknown, nothing is narrowed.
    expect(await exportsOf(`__all__ = base.__all__ + ["Foo"]\n${body}`)).toEqual(["Foo", "helper"]);
  });
});


describe("Python import aliases", () => {
  it("maps each renamed name to the module's own, absolute and relative", async () => {
    const src = `from league.goals import score_goal as sg, own_goal
from .goals import own_goal as og
from . import goals as g
import league.scoring as scoring`;
    const tree = await parseSource(src, "python" as never, "a.py");
    const out = new PythonImportExportExtractor().extractImports(tree, src).map((i) => [i.source, i.specifiers, i.aliases]);
    expect(out).toEqual([
      ["league.goals", ["sg", "score_goal", "own_goal"], { sg: "score_goal" }],
      [".goals", ["og", "own_goal"], { og: "own_goal" }],
      [".", ["g", "goals"], { g: "goals" }],
      // A whole-module import binds the module itself: nothing to rename.
      ["league.scoring", ["scoring"], undefined],
    ]);
  });
});
