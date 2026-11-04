/**
 * Per-test coverage contexts through the MCP tools: clarifydoc_file's tests
 * section and clarifydoc_impact say which tests the coverage run saw execute
 * a function, from which report — and say once when the report is
 * aggregate-only, rather than showing nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

let dir = "";
const sources: Record<string, string> = {
  "pyproject.toml": '[project]\nname = "league"\n[project.optional-dependencies]\ntest = ["pytest"]\n',
  "app/__init__.py": "",
  "app/club.py": [
    "class Club:",
    "    def __init__(self, name):",
    "        self.name = name",
    "        self.players = []",
    "",
    "    def sign(self, player):",
    "        self.players.append(player)",
    "        return len(self.players)",
    "",
    "    def release(self, player):",
    "        if player in self.players:",
    "            self.players.remove(player)",
    "            return True",
    "        return False",
    "",
    "",
    "def rank(clubs):",
    "    return sorted(clubs, key=lambda c: c.name)",
  ].join("\n"),
  "tests/__init__.py": "",
  "tests/test_club.py": [
    "from app.club import Club, rank",
    "",
    "",
    "class TestClub:",
    "    def test_sign(self):",
    '        c = Club("Rovers")',
    '        assert c.sign("Ann") == 1',
    "",
    "    def test_release(self):",
    '        c = Club("Rovers")',
    '        c.sign("Ann")',
    '        assert c.release("Ann")',
    "",
    "",
    "def test_rank():",
    '    assert [c.name for c in rank([Club("B"), Club("A")])] == ["A", "B"]',
  ].join("\n"),
};

// As `pytest --cov=app --cov-context=test` + `coverage json --show-contexts` writes it, trimmed.
const sign = "tests/test_club.py::TestClub::test_sign|run";
const release = "tests/test_club.py::TestClub::test_release|run";
const rankTest = "tests/test_club.py::test_rank|run";
const coverageJson = JSON.stringify({
  meta: { format: 3, version: "7.10.7", branch_coverage: false, show_contexts: true },
  files: {
    "app/club.py": {
      executed_lines: [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 17, 18],
      missing_lines: [14],
      excluded_lines: [],
      contexts: {
        "1": [""], "2": [""], "6": [""], "10": [""], "17": [""],
        "3": [sign, release, rankTest], "4": [sign, release, rankTest],
        "7": [sign, release], "8": [sign, release],
        "11": [release], "12": [release], "13": [release],
        "18": [rankTest],
      },
    },
  },
});
const coberturaXml = `<?xml version="1.0" ?><coverage line-rate="0.93"><sources><source>/ci/league</source></sources><packages><package name="app"><classes>
<class name="club.py" filename="app/club.py"><lines><line number="7" hits="1"/><line number="8" hits="1"/><line number="11" hits="1"/><line number="14" hits="0"/></lines></class>
</classes></package></packages></coverage>`;

async function project(name: string, report: [string, string]): Promise<void> {
  for (const [rel, text] of [...Object.entries(sources), report]) {
    await mkdir(dirname(join(dir, name, rel)), { recursive: true });
    await writeFile(join(dir, name, rel), text);
  }
  await analyze({ projectRoot: join(dir, name), outputDir: join(dir, `${name}-out`), lsp: false, gitHistory: false });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-coverage-contexts-"));
  await project("per-test", ["coverage.json", coverageJson]);
  await project("aggregate", ["coverage.xml", coberturaXml]);
}, 180_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const { server } = buildMcpServer({ projectRoot: join(dir, name), analysisDir: join(dir, `${name}-out`), allowAnalyze: false, allowColdStart: false, log: () => {} });
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return res.result.content[0]!.text;
}

describe("per-test coverage contexts in the MCP tools", () => {
  it("clarifydoc_file names the tests the coverage run saw execute each function, with the report", async () => {
    const text = await call("per-test", "clarifydoc_file", { path: "app/club.py", sections: ["tests"] });
    expect(text).toContain("tests the coverage run saw execute its functions — measured, per-test contexts from coverage.json:");
    expect(text).toContain("Club.release() line 10 ← TestClub.test_release tests/test_club.py:9");
    expect(text).toMatch(/Club\.sign\(\) line 6 ← TestClub\.test_release tests\/test_club\.py:9, TestClub\.test_sign tests\/test_club\.py:5/);
  });

  it("clarifydoc_impact lists the measured tests first and runs them by node id", async () => {
    const text = await call("per-test", "clarifydoc_impact", { files: ["app/club.py"] });
    expect(text).toContain("| Measured — tests that ran the change (coverage.json) |");
    expect(text).toContain("tests/test_club.py::TestClub::test_release");
    expect(text).toContain("tests/test_club.py::test_rank");
    expect(text.indexOf("Measured")).toBeLessThan(text.indexOf("| Tests to run"));
  });

  it("says once that an aggregate-only report has no per-test evidence", async () => {
    const file = await call("aggregate", "clarifydoc_file", { path: "app/club.py", sections: ["tests"] });
    expect(file).toContain("per-test evidence unavailable: coverage.xml records no test contexts (aggregate-only)");
    expect(file.match(/aggregate-only/g)).toHaveLength(1);
    const impact = await call("aggregate", "clarifydoc_impact", { files: ["app/club.py"] });
    expect(impact).toContain("| Per-test evidence | unavailable — coverage.xml records no test contexts");
  });
});
