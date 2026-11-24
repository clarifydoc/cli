import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A name binds only where its scope reaches: an import inside one function is that function's, a local or parameter
 * named like a class is the call head instead of the class, and a Go external test package (`package club_test`) is
 * a package of its own that reaches `club` through an import. Each project has a decoy whose right link must stay.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  python: {
    "pyproject.toml": "[project]\nname = \"league\"\n",
    "league/__init__.py": "",
    "league/util.py": "def helper():\n    return 1\n",
    "league/desk.py": `from league.util import helper


def own():
    return helper()


def local_import():
    from league.util import helper
    return helper()


def no_import():
    return helper()


def other_name():
    return helper()
`,
    "league/bench.py": `def sign():
    from league.util import helper
    return helper()


def bench():
    return helper()
`,
  },
  csharp: {
    "League.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n",
    "Audio.cs": `namespace League
{
    public class Audio
    {
        public static Audio Instance = new Audio();
        public void Click() { }
    }
}
`,
    "Garage.cs": `namespace League
{
    public class Garage
    {
        public void Click() { }
    }
}
`,
    "Desk.cs": `namespace League
{
    public class Desk
    {
        public void Local()
        {
            var Audio = new Garage();
            Audio.Click();
        }

        public void Param(Garage Audio)
        {
            Audio.Click();
        }

        public void Static()
        {
            Audio.Instance.Click();
        }

        public void Plain()
        {
            Audio.Instance.Click();
        }
    }
}
`,
  },
  go: {
    "go.mod": "module example.com/league\n\ngo 1.21\n",
    "club/club.go": `package club

func secret() int { return 1 }

func Public() int { return secret() }
`,
    "club/club_ext_test.go": `package club_test

import "testing"

func TestOutside(t *testing.T) {
	_ = secret()
}
`,
    "club/club_whitebox_test.go": `package club

import "testing"

func TestInside(t *testing.T) {
	_ = secret()
}
`,
    "club/club_helper_test.go": `package club_test

import "testing"

func helper() int { return 2 }

func TestHelped(t *testing.T) {
	_ = helper()
}
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `names-in-scope-${lang}-`));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    const out = join(root, ".out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    results[lang] = await loadReportSummary(out);
  }
}, 120_000);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const linksOf = (lang: string, sourceSymbol: string, callName: string, file?: string): SymbolLink[] =>
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName && (!file || l.sourceFile === file));

describe("symbol-linker — a name binds only where its scope reaches", () => {
  describe("Python", () => {
    it("binds an import inside a function to that function only", () => {
      expect(linksOf("python", "local_import", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
      expect(linksOf("python", "bench", "helper", "league/bench.py")).toEqual([]);
    });

    it("keeps the module-level import for every function of the module", () => {
      expect(linksOf("python", "own", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
      expect(linksOf("python", "other_name", "helper")[0]).toMatchObject({ targetSymbol: "helper", targetFile: "league/util.py" });
    });
  });

  describe("C#", () => {
    it("links a local or parameter named like a class to the local's type", () => {
      expect(linksOf("csharp", "Desk.Local", "Audio.Click")[0]).toMatchObject({ targetSymbol: "Garage.Click" });
      expect(linksOf("csharp", "Desk.Param", "Audio.Click")[0]).toMatchObject({ targetSymbol: "Garage.Click" });
    });

    it("keeps the static the class declares when no local hides it", () => {
      expect(linksOf("csharp", "Desk.Static", "Audio.Instance.Click")[0]).toMatchObject({ targetSymbol: "Audio.Click" });
    });
  });

  describe("Go", () => {
    it("reads an external test package as a package of its own", () => {
      expect(linksOf("go", "TestOutside", "secret")).toEqual([]);
      expect(linksOf("go", "TestHelped", "helper")[0]).toMatchObject({ targetFile: "club/club_helper_test.go" });
    });

    it("keeps an in-package test calling the package's unexported name", () => {
      expect(linksOf("go", "TestInside", "secret")[0]).toMatchObject({ targetFile: "club/club.go" });
    });
  });
});
