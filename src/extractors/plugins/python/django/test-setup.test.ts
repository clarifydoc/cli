import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import { fileTestVerdict } from "../../../../core/test-functions.js";
import type { FileAnalysis } from "../../../../types/analysis.js";

/**
 * Django's test run applies every app's migrations to the test database and calls each
 * AppConfig.ready() — code no test calls (real-repo FP: migrations and apps modules read as untested).
 */
const BASE: Record<string, string> = {
  "league/__init__.py": "",
  "league/apps.py": `from django.apps import AppConfig


class LeagueConfig(AppConfig):
    name = "league"

    def ready(self):
        from league import signals  # noqa: F401
`,
  "league/models.py": `from django.db import models


class Club(models.Model):
    name = models.CharField(max_length=100)
`,
  "league/migrations/__init__.py": "",
  "league/migrations/0002_backfill_names.py": `from django.db import migrations


def backfill(apps, schema_editor):
    Club = apps.get_model("league", "Club")
    Club.objects.filter(name="").update(name="unnamed")


class Migration(migrations.Migration):
    dependencies = [("league", "0001_initial")]
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
`,
  "league/standings.py": `def table():
    return []
`,
  "league/tests/test_clubs.py": `from django.test import TestCase


class TestClubs(TestCase):
    def test_nothing(self):
        self.assertTrue(True)
`,
};

const PYTEST = `[tool.pytest.ini_options]
DJANGO_SETTINGS_MODULE = "config.settings"
addopts = ["--reuse-db"]
`;

describe("files the Django test run executes while it sets up", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const verdicts = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "cd-django-test-setup-"));
    dirs.push(dir);
    for (const [rel, text] of Object.entries({ ...BASE, ...files })) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const out: Record<string, string> = {};
    for (const path of ["league/apps.py", "league/migrations/0002_backfill_names.py", "league/standings.py"]) {
      const file = JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
      const v = fileTestVerdict(summary, path, file);
      out[path] = `${v.state}${v.basis.length ? ` (${v.basis.join(", ")})` : ""}`;
    }
    return out;
  };

  it("pytest-django applies the migrations and calls ready()", async () => {
    expect(await verdicts({ "pyproject.toml": PYTEST })).toEqual({
      "league/apps.py": "tested (test-setup)",
      "league/migrations/0002_backfill_names.py": "tested (test-setup)",
      "league/standings.py": "untested",
    });
  }, 60_000);

  it("--nomigrations, or settings swapping MIGRATION_MODULES, leave the migrations out", async () => {
    const off = {
      "league/apps.py": "tested (test-setup)",
      "league/migrations/0002_backfill_names.py": "untested",
      "league/standings.py": "untested",
    };
    expect(await verdicts({ "pytest.ini": "[pytest]\nDJANGO_SETTINGS_MODULE = config.settings\naddopts = --nomigrations\n" })).toEqual(off);
    expect(await verdicts({
      "pyproject.toml": PYTEST,
      "config/settings.py": `import sys\nif "pytest" in sys.modules:\n    MIGRATION_MODULES = {"league": None}\n`,
    })).toEqual(off);
  }, 60_000);

  it("Django's own runner (manage.py, no pytest configuration) sets up the same way; no stated runner says nothing", async () => {
    expect((await verdicts({ "manage.py": "import django\n" }))["league/migrations/0002_backfill_names.py"]).toBe("tested (test-setup)");
    // A pytest configuration that does not say it runs Django (pytest-django set up elsewhere): unknown.
    expect(await verdicts({ "pyproject.toml": "[tool.pytest.ini_options]\naddopts = [\"-q\"]\n", "manage.py": "import django\n" })).toEqual({
      "league/apps.py": "untested",
      "league/migrations/0002_backfill_names.py": "untested",
      "league/standings.py": "untested",
    });
  }, 60_000);
});
