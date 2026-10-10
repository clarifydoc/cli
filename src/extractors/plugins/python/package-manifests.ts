import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, tomlSectionValue } from "../shared/declared-package.js";

/** requirements.txt-style lines (also each entry of a pyproject dependency array). */
function parseRequirements(text: string, declaredIn: string, isDev: boolean): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue; // skip -r/-e/-i flags
    if (/^(https?|git\+|file):/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*(\[[^\]]*\])?\s*([<>=!~]=?.*)?$/);
    if (!m) continue;
    const version = m[3]?.trim() || null;
    out.push(declared(m[1]!, version, "pypi", isDev ? "dev" : "prod", declaredIn));
  }
  return out;
}

/**
 * `pyproject.toml`: [project] dependencies = [...], optional-dependencies (dev),
 * [tool.poetry.dependencies] / [tool.poetry.group.*.dependencies] (dev when
 * group != main). A minimal section scan, not a TOML parser.
 */
function parsePyproject(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const lines = text.split(/\r?\n/);
  let mode: "none" | "pep621" | "pep621-optional" | "poetry-main" | "poetry-dev" = "none";
  const quotedEntries = (line: string, isDev: boolean) => {
    // each quoted entry "pkg>=1.0", "celery[redis]~=5.5"
    for (const q of line.matchAll(/["']([A-Za-z0-9_.-]+[^"']*)["']/g)) {
      out.push(...parseRequirements(q[1]!, declaredIn, isDev));
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const s = section[1]!;
      // PEP 621 extras: `group = ["pkg>=1", …]` — arrays of requirements, not Poetry `name = "version"`.
      if (/optional-dependencies/.test(s)) mode = "pep621-optional";
      else if (/tool\.poetry\.dependencies/.test(s)) mode = "poetry-main";
      else if (/tool\.poetry\.(group\..*\.)?dependencies/.test(s)) mode = "poetry-dev";
      else mode = "none";
      continue;
    }
    if (mode === "pep621-optional") {
      quotedEntries(line, true);
      continue;
    }
    if (mode === "none") {
      const arr = line.match(/^dependencies\s*=\s*\[/);
      if (arr) mode = "pep621";
    }
    if (mode === "pep621") {
      quotedEntries(line, false);
      // The array closes on a `]` OUTSIDE quotes — `"celery[redis]~=5.5"` has
      // one inside, and ending there dropped every dependency after it.
      if (line.replace(/(["'])(?:(?!\1).)*\1/g, "").includes("]")) mode = "none";
      continue;
    }
    if (mode === "poetry-main" || mode === "poetry-dev") {
      const dep = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (dep && dep[1]!.toLowerCase() !== "python") {
        const v = dep[2]!.match(/"([^"]+)"/)?.[1] ?? null;
        out.push(declared(dep[1]!, v, "pypi", mode === "poetry-dev" ? "dev" : "prod", declaredIn));
      }
    }
  }
  return out;
}

/** `Pipfile` [packages] / [dev-packages]. */
function parsePipfile(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let scope: PackageScope | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const s = sec[1]!.toLowerCase();
      scope = s === "packages" ? "prod" : s === "dev-packages" ? "dev" : null;
      continue;
    }
    if (!scope) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const v = m[2]!.match(/"([^"]*)"/)?.[1] ?? null;
    out.push(declared(m[1]!, v && v !== "*" ? v : null, "pypi", scope, declaredIn));
  }
  return out;
}

export const pypiPackageManager: PackageManagerSpec = {
  ecosystem: "pypi",
  manifests: [
    {
      files: ["pyproject.toml"],
      parse: (text, file) => parsePyproject(text, file.declaredIn),
      // `[project] name` (PEP 621) or Poetry's `[tool.poetry] name`.
      selfName: (text) => tomlSectionValue(text, ["project", "tool.poetry"], "name"),
    },
    { files: ["Pipfile"], parse: (text, file) => parsePipfile(text, file.declaredIn) },
    {
      files: ["requirements*.txt", "**/requirements*.txt"],
      glob: { deep: 2, limit: 20 },
      // `requirements-dev.txt`, `test/requirements.txt`: tooling only.
      parse: (text, file) => parseRequirements(text, file.declaredIn, /dev|test/i.test(file.path)),
    },
  ],
  // `django.db.models` → `django`; `typing_extensions` is published as `typing-extensions`.
  importKey: (s) => (s.startsWith(".") ? null : s.split(".")[0]!.toLowerCase().replace(/_/g, "-")),
  packageKey: (name) => name.toLowerCase().replace(/_/g, "-"),
};
