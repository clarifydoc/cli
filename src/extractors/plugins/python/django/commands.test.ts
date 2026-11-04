import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import { fileTestVerdict } from "../../../../core/test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../../types/analysis.js";

/** A test runs a management command by name (real-repo FP: nine commands its tests run read as untested). */
const FILES: Record<string, string> = {
  "manage.py": "import django\n",
  "league/management/__init__.py": "",
  "league/management/commands/__init__.py": "",
  "league/management/commands/base.py": `from django.core.management.base import BaseCommand
class LeagueCommand(BaseCommand):
    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")
`,
  "league/management/commands/close_season.py": `from .base import LeagueCommand
from league.standings import final_table

class Command(LeagueCommand):
    def handle(self, *args, **options):
        final_table()
`,
  "league/management/commands/open_window.py": `from django.core.management.base import BaseCommand

class Command(BaseCommand):
    def handle(self, *args, **options):
        pass
`,
  "transfers/management/commands/open_window.py": `from django.core.management.base import BaseCommand

class Command(BaseCommand):
    def handle(self, *args, **options):
        pass
`,
  "league/standings.py": `def final_table():
    return []
`,
  "league/tests/test_commands.py": `from django.core import management
from django.core.management import call_command
from django.test import TestCase

class TestCloseSeason(TestCase):
    def test_close(self):
        call_command("close_season", "--dry-run")

    def test_window(self):
        management.call_command("open_window")

    def test_by_variable(self):
        name = "close_season"
        call_command(name)
`,
};

describe("Django management commands run by name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-django-commands-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (symbol: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "league/tests/test_commands.py" && l.sourceSymbol === symbol && l.strategy === "dispatch:django-command")
      .map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("links call_command to the command's options and handle, an inherited add_arguments on its base", () => {
    expect(linksFrom("TestCloseSeason.test_close")).toEqual([
      "league/management/commands/base.py::LeagueCommand.add_arguments",
      "league/management/commands/close_season.py::Command.handle",
    ]);
  });

  it("joins no command two apps declare, and no name built at run time", () => {
    expect(linksFrom("TestCloseSeason.test_window")).toEqual([]);
    expect(linksFrom("TestCloseSeason.test_by_variable")).toEqual([]);
  });

  it("calls the command and what it runs tested", async () => {
    const file = async (path: string) => JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
    for (const path of ["league/management/commands/close_season.py", "league/standings.py", "league/management/commands/base.py"]) {
      expect(fileTestVerdict(summary, path, await file(path)).state, path).toBe("tested");
    }
    const other = "transfers/management/commands/open_window.py";
    expect(fileTestVerdict(summary, other, await file(other)).state).toBe("untested");
  });
});
