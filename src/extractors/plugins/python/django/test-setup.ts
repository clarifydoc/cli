import type { FileAnalysis } from "../../../../types/analysis.js";
import type { ProjectRootView } from "../../../../types/language-plugin.js";

/**
 * `MIGRATION_MODULES = …` assigned anywhere in a file (usually settings, often only for a test
 * run): the test database may be built without the apps' migrations, so none is said to run then.
 */
export const DJ_MIGRATION_MODULES = "dj:migration-modules";

/**
 * `INSTALLED_APPS = [...]` / `+= [...]` assigned in a file: the dotted entries, and whether every item of the
 * statement was a string literal in a plain list (a name, a spread or `BASE + [...]` makes the list unknown).
 */
export const DJ_INSTALLED_APPS = "dj:installed-apps";
export interface DjInstalledAppsFact {
  entries: string[];
  complete: boolean;
}

const INSTALLED_APPS = /^[ \t]*INSTALLED_APPS\s*(\+?=)[ \t]*/gm;

/** The `INSTALLED_APPS` statements of a settings file, in source order. */
export function installedAppsOf(sourceText: string): Array<{ line: number; data: DjInstalledAppsFact }> {
  const out: Array<{ line: number; data: DjInstalledAppsFact }> = [];
  for (const m of sourceText.matchAll(INSTALLED_APPS)) {
    const start = m.index! + m[0].length;
    const line = sourceText.slice(0, m.index).split("\n").length;
    const open = sourceText[start];
    const close = open === "[" ? "]" : open === "(" ? ")" : null;
    if (!close) {
      out.push({ line, data: { entries: [], complete: false } });
      continue;
    }
    const entries: string[] = [];
    let complete = true;
    let depth = 0;
    let i = start;
    let end = -1;
    for (; i < sourceText.length; i++) {
      const ch = sourceText[i]!;
      if (ch === "#") { while (i < sourceText.length && sourceText[i] !== "\n") i++; continue; }
      if (ch === '"' || ch === "'") {
        const q = ch;
        let j = i + 1;
        while (j < sourceText.length && sourceText[j] !== q && sourceText[j] !== "\n") j++;
        if (depth === 1) entries.push(sourceText.slice(i + 1, j));
        i = j;
        continue;
      }
      if (ch === "[" || ch === "(" || ch === "{") {
        depth++;
        if (depth > 1) complete = false; // a nested call or list is no plain entry
      } else if (ch === "]" || ch === ")" || ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      } else if (depth === 1 && /[\w*+.%]/.test(ch)) complete = false; // a name, a spread or an operator between strings
    }
    if (end < 0) complete = false;
    else if (/^[ \t]*[+*%.]/.test(sourceText.slice(end + 1))) complete = false; // `[...] + other_apps`
    out.push({ line, data: { entries, complete } });
  }
  return out;
}

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
  // The settings' INSTALLED_APPS, where every statement of it is a literal list: only an app listed there is set up.
  const installed = installedApps(python);
  const appDirs = installed ? [...new Set(python.flatMap((f) => [MIGRATION_FILE.exec(f.filePath)?.[1], /(?:^|\/)apps\.py$/.test(f.filePath) ? f.filePath.replace(/\/?apps\.py$/, "") : undefined]).filter((d): d is string => d !== undefined))] : [];
  const running = installed ? runningApps(installed, appDirs) : null;
  const installs = (dir: string) => !running || running.has(dir);
  const out: Array<{ file: string; reason: string }> = [];
  for (const f of python) {
    const migration = MIGRATION_FILE.exec(f.filePath);
    if (migration) {
      if (migrations && f.classes.some((c) => c.name === "Migration") && isApp(migration[1] ?? "") && installs(migration[1] ?? "")) {
        out.push({ file: f.filePath, reason: "a migration the test run applies when it creates the test database" });
      }
      continue;
    }
    if (/(?:^|\/)apps\.py$/.test(f.filePath) && installs(f.filePath.replace(/\/?apps\.py$/, "")) && f.classes.some((c) => /(?:^|\.)AppConfig$/.test(c.extends ?? "") && c.methods.some((m) => m.name === "ready"))) {
      out.push({ file: f.filePath, reason: "its AppConfig.ready() runs when the test run sets Django up" });
    }
  }
  return out;
}

/** The entries of every INSTALLED_APPS statement, or null where the project states none or one that is not a plain list. */
function installedApps(python: readonly FileAnalysis[]): string[] | null {
  const entries: string[] = [];
  let any = false;
  for (const f of python) {
    for (const fact of f.routeFacts ?? []) {
      if (fact.kind !== DJ_INSTALLED_APPS) continue;
      const data = fact.data as DjInstalledAppsFact;
      if (!data.complete) return null;
      any = true;
      entries.push(...data.entries);
    }
  }
  return any ? entries : null;
}

/**
 * The app directories (of `dirs`) the entries install: an entry names the app's package (`league`,
 * `core.league`) or its configuration (`league.apps.LeagueConfig`), so each of its dotted prefixes is tried
 * against the directories, exact paths before a directory only ending in them (sources under `src/`).
 */
function runningApps(entries: readonly string[], dirs: readonly string[]): Set<string> {
  const dotted = dirs.map((d) => [d, d.replace(/\//g, ".")] as const);
  const out = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split(".");
    for (let n = parts.length; n >= 1; n--) {
      const prefix = parts.slice(0, n).join(".");
      const exact = dotted.filter(([, d]) => d === prefix);
      const hits = exact.length > 0 ? exact : dotted.filter(([, d]) => d.endsWith(`.${prefix}`));
      if (hits.length === 0) continue;
      for (const [dir] of hits) out.add(dir);
      break;
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
