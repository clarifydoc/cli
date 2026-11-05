import type { FileAnalysis } from "../../../../types/analysis.js";
import type { ProjectRootView } from "../../../../types/language-plugin.js";

/**
 * `MIGRATION_MODULES = …` assigned anywhere in a file (usually settings, often only for a test
 * run): the test database may be built without the apps' migrations, so none is said to run then.
 */
export const DJ_MIGRATION_MODULES = "dj:migration-modules";

/**
 * What a Django project's test run executes before any test calls it: the
 * runner sets Django up — every installed app's `AppConfig.ready()` — and
 * creates the test database by applying every app's migrations, a
 * migration's `RunPython` functions included.
 *
 * Said only where the configuration states the runner: pytest-django (the
 * pytest configuration names `DJANGO_SETTINGS_MODULE` or `--ds`), or Django's
 * own runner (`manage.py` and no pytest configuration). Migrations are left
 * out when pytest runs with `--nomigrations` / `--no-migrations`, or when a
 * module assigns `MIGRATION_MODULES` (settings that swap the migrations out
 * for a test run). A project with no test file says nothing. Leaf code: the
 * static manifest uses it.
 */
export function djangoTestSetupRuns(root: ProjectRootView, files: readonly FileAnalysis[]): Array<{ file: string; reason: string }> {
  const python = files.filter((f) => f.language === "python");
  if (!python.some((f) => TEST_FILE.test(f.filePath))) return [];
  const pytest = pytestConfig(root);
  const django = pytest !== null ? /\bDJANGO_SETTINGS_MODULE\b|--ds\b/.test(pytest) : root.entries.includes("manage.py");
  if (!django) return [];
  const migrations = !(pytest !== null && /--no-?migrations\b/.test(pytest)) && !python.some((f) => f.routeFacts?.some((r) => r.kind === DJ_MIGRATION_MODULES));

  const paths = new Set(python.map((f) => f.filePath));
  const isApp = (dir: string) => ["apps.py", "models.py", "models/__init__.py"].some((n) => paths.has(dir ? `${dir}/${n}` : n));
  const out: Array<{ file: string; reason: string }> = [];
  for (const f of python) {
    const migration = MIGRATION_FILE.exec(f.filePath);
    if (migration) {
      if (migrations && f.classes.some((c) => c.name === "Migration") && isApp(migration[1] ?? "")) {
        out.push({ file: f.filePath, reason: "a migration the test run applies when it creates the test database" });
      }
      continue;
    }
    if (/(?:^|\/)apps\.py$/.test(f.filePath) && f.classes.some((c) => /(?:^|\.)AppConfig$/.test(c.extends ?? "") && c.methods.some((m) => m.name === "ready"))) {
      out.push({ file: f.filePath, reason: "its AppConfig.ready() runs when the test run sets Django up" });
    }
  }
  return out;
}

const TEST_FILE = /(?:^|\/)tests?\/|(?:^|\/)test_[^/]*\.py$|_tests?\.py$|(?:^|\/)conftest\.py$/;
/** `league/migrations/0002_backfill.py` → `league`. */
const MIGRATION_FILE = /^(?:(.*)\/)?migrations\/\d{3,}_[^/]+\.py$/;

/**
 * The pytest configuration section, in the order pytest looks for it: `pytest.ini`, `pyproject.toml`
 * (`[tool.pytest.ini_options]`, or pytest 9's `[tool.pytest]`), `tox.ini` (`[pytest]`), `setup.cfg`
 * (`[tool:pytest]`). Null when the root states none.
 */
function pytestConfig(root: ProjectRootView): string | null {
  const sources: Array<[string, string[]]> = [
    ["pytest.ini", ["pytest"]],
    ["pyproject.toml", ["tool.pytest.ini_options", "tool.pytest"]],
    ["tox.ini", ["pytest"]],
    ["setup.cfg", ["tool:pytest"]],
  ];
  for (const [file, headers] of sources) {
    const text = root.entries.includes(file) ? root.read(file) : undefined;
    if (text === undefined) continue;
    for (const header of headers) {
      const section = sectionOf(text, header);
      if (section !== null) return section;
    }
    if (file === "pytest.ini") return ""; // pytest.ini is pytest's file even with no section
  }
  return null;
}

/** The body of an INI / TOML section `[header]`, up to the next section. */
function sectionOf(text: string, header: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]\s*$/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}
