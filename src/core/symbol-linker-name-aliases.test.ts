/**
 * A module-level alias of a function (`s = attributes = attrs`, `club = attrs`,
 * `export const s = attrs`) is followed to the function, through the module's
 * imports. Through the real per-file pipeline, then the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "name-aliases-"));
  const out = await mkdtemp(join(tmpdir(), "name-aliases-out-"));
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

function callsFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)" && l.sourceSymbol !== "<setup>")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("module-level function aliases", () => {
  it("Python: follows a chained alias and a plain one, in the package and in the defining module", async () => {
    const analyses = await analyzeAll({
      "league/_make.py": "def attrs(cls=None):\n    return cls\n\n\nmake = attrs\n\n\ndef season():\n    return make()\n",
      "league/__init__.py": "from ._make import attrs\n\ns = attributes = attrs\nclub = attrs\n",
      "league/players.py": [
        "import league",
        "from league import s, club, attributes",
        "from league._make import make",
        "",
        "",
        "def build_player():",
        "    league.s()",
        "    s()",
        "    club()",
        "    attributes()",
        "    make()",
        "",
      ].join("\n"),
    }, "python");
    expect(analyses.find((a) => a.filePath === "league/__init__.py")?.nameAliases?.map((a) => `${a.name}=${a.target}`))
      .toEqual(["s=attrs", "attributes=attrs", "club=attrs"]);
    expect(callsFrom(analyses, "league/players.py")).toEqual([
      "attributes -> league/_make.py::attrs",
      "club -> league/_make.py::attrs",
      "league.s -> league/_make.py::attrs",
      "make -> league/_make.py::attrs",
      "s -> league/_make.py::attrs",
    ]);
    expect(callsFrom(analyses, "league/_make.py")).toEqual(["make -> league/_make.py::attrs"]);
  });

  it("Python: a name bound to two different targets decides nothing", async () => {
    const analyses = await analyzeAll({
      "league/rules.py": "def strict():\n    return 1\n\n\ndef relaxed():\n    return 2\n\n\nreferee = strict\nreferee = relaxed\n",
      "league/match.py": "from league.rules import referee\n\n\ndef kick_off():\n    referee()\n",
    }, "python");
    expect(callsFrom(analyses, "league/match.py").filter((l) => l.includes("rules.py::strict") || l.includes("rules.py::relaxed"))).toEqual([]);
  });

  it("Python: a call through a package's dotted module path reaches the name the last module defines or aliases", async () => {
    const analyses = await analyzeAll({
      "league/__init__.py": "from ._make import attrs\n",
      "league/_make.py": "def attrs(cls=None):\n    return cls\n\n\ns = attrs\n",
      "league/cup/__init__.py": "",
      "league/cup/draw.py": "def pick(n):\n    return n\n\n\nlots = pick\n",
      "league/players.py": [
        "import league",
        "import league.cup.draw",
        "",
        "",
        "def build_player():",
        "    league._make.s()",
        "    league.cup.draw.pick(1)",
        "    league.cup.draw.lots(2)",
        "",
      ].join("\n"),
      "league/coach.py": "import league._make as unused\nimport league._make\n\n\ndef train():\n    league._make.s()\n",
    }, "python");
    expect(callsFrom(analyses, "league/players.py")).toEqual([
      "league._make.s -> league/_make.py::attrs",
      "league.cup.draw.lots -> league/cup/draw.py::pick",
      "league.cup.draw.pick -> league/cup/draw.py::pick",
    ]);
    expect(callsFrom(analyses, "league/coach.py")).toEqual(["league._make.s -> league/_make.py::attrs"]);
  });

  it("TypeScript: follows `export const s = attrs` in the defining module and through an import", async () => {
    const analyses = await analyzeAll({
      "src/make.ts": "export function attrs(x?: number) { return x; }\nexport const s = attrs;\nlet later = attrs;\n",
      "src/index.ts": "import { attrs } from \"./make\";\nexport const club = attrs;\n",
      "src/players.ts": "import { s } from \"./make\";\nimport { club } from \"./index\";\nexport function buildPlayer() { s(1); club(2); }\n",
    }, "typescript");
    expect(analyses.find((a) => a.filePath === "src/make.ts")?.nameAliases?.map((a) => `${a.name}=${a.target}`)).toEqual(["s=attrs"]);
    expect(callsFrom(analyses, "src/players.ts")).toEqual([
      "club -> src/make.ts::attrs",
      "s -> src/make.ts::attrs",
    ]);
  });

  it("TypeScript: a default import under another name reaches the default-exported function", async () => {
    const analyses = await analyzeAll({
      "src/tyre.ts": "function inflate(): number { return 32; }\nexport default inflate;\n",
      "src/wax.ts": "export default function polishEngine(): void {}\n",
      "src/main.ts": "import pump from \"./tyre\";\nimport shine from \"./wax\";\nexport function runGarage(): void { pump(); shine(); }\n",
    }, "typescript");
    expect(callsFrom(analyses, "src/main.ts")).toEqual([
      "pump -> src/tyre.ts::inflate",
      "shine -> src/wax.ts::polishEngine",
    ]);
  });

  it("an alias of a value stays the value's own name", () => {
    const version = {
      filePath: "src/cache/version.ts", language: "typescript", projectId: "root", imports: [], functions: [], classes: [], routes: [], dataSources: [],
      exports: [{ name: "PITCH_VERSION", kind: "variable", line: 1 }, { name: "DATA_VERSION", kind: "variable", line: 2 }],
      nameAliases: [{ name: "DATA_VERSION", target: "PITCH_VERSION", line: 2 }],
    } as unknown as FileAnalysis;
    const store = {
      filePath: "src/cache/store.ts", language: "typescript", projectId: "root", exports: [], classes: [], routes: [], dataSources: [],
      imports: [{ source: "./version", specifiers: ["DATA_VERSION"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
      functions: [{ name: "openStore", line: 2, endLine: 4, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [{ name: "DATA_VERSION", kind: "cross-file", target: "./version", line: 3 }] }],
    } as unknown as FileAnalysis;
    expect(callsFrom([version, store], "src/cache/store.ts")).toEqual(["DATA_VERSION -> src/cache/version.ts::DATA_VERSION"]);
  });
});
