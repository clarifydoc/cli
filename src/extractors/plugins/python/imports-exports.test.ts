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
        from gitprobe.core.analysis_limits import reset_global_tracker
        reset_global_tracker()
        for f in files:
            if f.lang == "python":
                from gitprobe.analyzers.python import analyze_python_file
                analyze_python_file(f)

@cached
def helper():
    import json
    return json
`)).toEqual([
      { source: "pathlib", specifiers: ["Path"], isType: false, line: 2 },
      { source: "gitprobe.core.analysis_limits", specifiers: ["reset_global_tracker"], isType: false, line: 6 },
      { source: "gitprobe.analyzers.python", specifiers: ["analyze_python_file"], isType: false, line: 10 },
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
    from app.models import User
elif FEATURE:
    from app.feature import flag
else:
    from app.runtime import Runtime

if typing.TYPE_CHECKING:
    from app.db import Session
`)).toEqual([
      { source: "typing", specifiers: ["TYPE_CHECKING"], isType: false, line: 2 },
      { source: "typing", specifiers: ["typing"], isType: false, line: 3 },
      { source: "app.models", specifiers: ["User"], isType: true, line: 6 },
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
from .user import User as Account, Group
from mealie.schema import *
from typing import Any
def helper():
    from .late import x
`;
    const tree = await parseSource(src, "python" as any, "pkg/__init__.py");
    const exports = new PythonImportExportExtractor().extractExports(tree, src).filter((e) => e.kind === "re-export");
    expect(exports.map((e) => [e.name, e.source, e.sourceName])).toEqual([
      ["*", ".dependencies", undefined],
      ["Account", ".user", "User"],
      ["Group", ".user", undefined],
      ["*", "mealie.schema", undefined],
    ]);
  });
});
