import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, tomlSectionValue } from "../shared/declared-package.js";
import { parsePipfileLock, parseTomlPackageLock, withLocked } from "../shared/lockfiles.js";

/**
 * One PEP 508 requirement: `name`, optional `[extras]`, then a version spec —
 * bare (`>=2,<3`) or parenthesized (`(>=2,<3)`) — or `@ url`, then an
 * optional `; marker`. The marker is dropped (it says where the package is
 * installed, not which one); a URL reference has no version. Null when the
 * text is no requirement.
 */
export function parseRequirement(text: string): { name: string; version: string | null } | null {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/s.exec(text);
  if (!m) return null;
  let rest = m[2]!.trim();
  if (rest.startsWith("@")) {
    // `name @ url ; marker` — the URL is the reference; PEP 508 wants a space before its marker.
    return /^@\s*\S/.test(rest) ? { name: m[1]!, version: null } : null;
  }
  const semi = rest.indexOf(";");
  if (semi >= 0) rest = rest.slice(0, semi).trim();
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close < 0) return null;
    rest = rest.slice(1, close).trim();
  }
  if (rest && !/^(?:[<>=!~]=?|===)/.test(rest)) return null;
  return { name: m[1]!, version: rest || null };
}

/** requirements.txt lines: one requirement each, `\` continuations joined, pip options and comments dropped. */
function parseRequirements(text: string, declaredIn: string, isDev: boolean): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    // A comment starts at a `#` after whitespace; `#egg=` inside a URL is part of it.
    const line = raw.replace(/(?:^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue; // -r/-e/-i/-c lines
    if (/^(?:https?|git\+[a-z]+|file):/.test(line)) continue; // a bare URL names no package
    // Per-requirement options (`--hash=…`, `--config-settings …`) follow the requirement.
    const req = parseRequirement(line.replace(/\s--?[a-z].*$/i, ""));
    if (req) out.push(declared(req.name, req.version, "pypi", isDev ? "dev" : "prod", declaredIn));
  }
  return out;
}

/**
 * The string elements of the TOML array opening at `text[start]` (`[`), and
 * where it ends: quote-aware, so a `]` or `#` inside `"celery[redis]"` or a
 * marker's `'3.11'` neither closes it nor starts a comment; strings inside an
 * inline table (`{include-group = "lint"}`) are not elements.
 */
function tomlStringArray(text: string, start: number): { items: string[]; end: number } {
  const items: string[] = [];
  let depth = 0;
  let braces = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return { items, end: text.length };
      i = nl;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      let value = "";
      while (j < text.length && !text.startsWith(quote, j)) {
        if (c === '"' && text[j] === "\\" && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
          continue;
        }
        value += text[j];
        j++;
      }
      if (braces === 0 && depth === 1) items.push(value);
      i = j + quote.length - 1;
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return { items, end: i + 1 };
  }
  return { items, end: text.length };
}

/** A TOML key as written (`fastapi`, `"zope.interface"`), unquoted. */
const TOML_KEY = String.raw`(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))`;

/**
 * `pyproject.toml`, table by table — a minimal scan, not a TOML parser:
 * `[project] dependencies` (prod), `[project.optional-dependencies]`
 * (optional), `[dependency-groups]` and `[tool.uv] dev-dependencies` (dev),
 * `[tool.poetry.dependencies]` (prod, `python` excepted; a `.<name>` subtable
 * is that one package), `[tool.poetry.dev-dependencies]` and
 * `[tool.poetry.group.<g>.dependencies]` (dev unless the group is `main`),
 * `[tool.pdm.dev-dependencies]` and a Hatch environment's `dependencies`
 * (dev: tooling, never what the package installs). Array entries are PEP 508.
 */
function parsePyproject(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  /** How the current table's keys declare packages. */
  type Mode =
    | { kind: "none" }
    | { kind: "arrays"; keys: ReadonlySet<string> | null; scope: PackageScope } // `key = ["pep508", …]`
    | { kind: "poetry"; scope: PackageScope } // `name = "spec"` / `name = { version = … }`
    | { kind: "poetry-one"; name: string; scope: PackageScope; version: string | null; optional: boolean };
  let mode: Mode = { kind: "none" };
  const flush = () => {
    if (mode.kind === "poetry-one") out.push(declared(mode.name, mode.version, "pypi", mode.optional ? "optional" : mode.scope, declaredIn));
  };
  const keyRe = new RegExp(`^${TOML_KEY}\\s*=\\s*`);
  const poetryTable = (table: string): Mode => {
    const t = /^tool\.poetry\.(?:(dependencies|dev-dependencies)|group\.(?:"([^"]+)"|([^.]+))\.dependencies)(?:\.(?:"([^"]+)"|(.+)))?$/.exec(table);
    if (!t) return { kind: "none" };
    const group = t[2] ?? t[3];
    const scope: PackageScope = t[1] === "dependencies" || group === "main" ? "prod" : "dev";
    const one = t[4] ?? t[5];
    if (one === undefined) return { kind: "poetry", scope };
    return one.toLowerCase() === "python" ? { kind: "none" } : { kind: "poetry-one", name: one, scope, version: null, optional: false };
  };
  const tableMode = (table: string): Mode => {
    if (table === "project") return { kind: "arrays", keys: new Set(["dependencies"]), scope: "prod" };
    if (table === "project.optional-dependencies") return { kind: "arrays", keys: null, scope: "optional" };
    if (table === "dependency-groups" || table === "tool.pdm.dev-dependencies") return { kind: "arrays", keys: null, scope: "dev" };
    if (table === "tool.uv") return { kind: "arrays", keys: new Set(["dev-dependencies"]), scope: "dev" };
    if (/^tool\.hatch\.envs\.[^.]+$/.test(table)) return { kind: "arrays", keys: new Set(["dependencies", "extra-dependencies"]), scope: "dev" };
    return poetryTable(table);
  };
  const pushRequirements = (items: readonly string[], scope: PackageScope) => {
    for (const item of items) {
      const req = parseRequirement(item);
      if (req) out.push(declared(req.name, req.version, "pypi", scope, declaredIn));
    }
  };

  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(pos, lineEnd).trim();
    const next = lineEnd + 1;
    const header = /^\[\s*([^\[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
    if (header || /^\[\[/.test(line)) {
      flush();
      // An array of tables (`[[tool.poetry.source]]`) declares no dependency.
      mode = header ? tableMode(header[1]!.replace(/\s*\.\s*/g, ".").replace(/^"([^"]+)"$/, "$1")) : { kind: "none" };
      pos = next;
      continue;
    }
    const kv = keyRe.exec(line);
    if (!kv || mode.kind === "none") {
      pos = next;
      continue;
    }
    const key = kv[1] ?? kv[2] ?? kv[3]!;
    const valueAt = pos + text.slice(pos, lineEnd).indexOf(line) + kv[0].length;
    if (text[valueAt] === "[") {
      // An array, possibly over several lines: read it whole so its lines are never read as keys.
      const { items, end } = tomlStringArray(text, valueAt);
      if (mode.kind === "arrays" && (mode.keys === null || mode.keys.has(key))) pushRequirements(items, mode.scope);
      else if (mode.kind === "poetry" && key.toLowerCase() !== "python") {
        // Several constraints (`x = [{ version = "^1", python = "<3.9" }, …]`): one package.
        const version = /version\s*=\s*"([^"]*)"/.exec(text.slice(valueAt, end))?.[1] ?? null;
        out.push(declared(key, version, "pypi", mode.scope, declaredIn));
      }
      const after = text.indexOf("\n", end);
      pos = after < 0 ? text.length : after + 1;
      continue;
    }
    const value = text.slice(valueAt, lineEnd);
    if (mode.kind === "poetry" && key.toLowerCase() !== "python") {
      const inline = value.trimStart().startsWith("{");
      const version = inline ? (/\bversion\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? null) : (/^\s*"([^"]*)"/.exec(value)?.[1] ?? null);
      const optional = inline && /\boptional\s*=\s*true\b/.test(value);
      out.push(declared(key, version || null, "pypi", optional ? "optional" : mode.scope, declaredIn));
    } else if (mode.kind === "poetry-one") {
      if (key === "version") mode.version = /^\s*"([^"]*)"/.exec(value)?.[1] || null;
      else if (key === "optional") mode.optional = /^\s*true\b/.test(value);
    }
    pos = next;
  }
  flush();
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

/**
 * Top-level modules whose name is not their distribution's (`import yaml` is PyYAML). The keys are the
 * normalized distribution names `packageKey` produces; a module absent here is its own distribution.
 */
const IMPORT_DISTRIBUTIONS: Record<string, string> = {
  yaml: "pyyaml",
  PIL: "pillow",
  sklearn: "scikit-learn",
  bs4: "beautifulsoup4",
  cv2: "opencv-python",
  dateutil: "python-dateutil",
  jwt: "pyjwt",
  dotenv: "python-dotenv",
  attr: "attrs",
  serial: "pyserial",
  Crypto: "pycryptodome",
  Cryptodome: "pycryptodomex",
  OpenSSL: "pyopenssl",
  MySQLdb: "mysqlclient",
  magic: "python-magic",
  git: "gitpython",
  docx: "python-docx",
  pptx: "python-pptx",
  slugify: "python-slugify",
  multipart: "python-multipart",
  jose: "python-jose",
  socks: "pysocks",
  skimage: "scikit-image",
  zmq: "pyzmq",
  gi: "pygobject",
  googleapiclient: "google-api-python-client",
  win32api: "pywin32",
  win32con: "pywin32",
  win32com: "pywin32",
  pythoncom: "pywin32",
};

/** Distributions that ship one module under several names: the variants answer to the first. */
const DISTRIBUTION_FAMILIES = new Map<string, string>([
  ["opencv-python-headless", "opencv-python"],
  ["opencv-contrib-python", "opencv-python"],
  ["opencv-contrib-python-headless", "opencv-python"],
  ["psycopg2-binary", "psycopg2"],
  ["psycopg-binary", "psycopg"],
]);

/** A shared `google.*` namespace: the second segment names the distribution. */
const GOOGLE_NAMESPACE: Record<string, string> = {
  protobuf: "protobuf",
  auth: "google-auth",
  oauth2: "google-auth",
  api_core: "google-api-core",
};

/** The distribution key an import names (`google.protobuf.message` → `protobuf`); null for a relative one. */
function distributionOfImport(source: string): string {
  const [head = "", second = ""] = source.split(".");
  if (head === "google") {
    const service = source.split(".")[2];
    if (second === "cloud" && service) return `google-cloud-${service.replace(/_/g, "-")}`.toLowerCase();
    return GOOGLE_NAMESPACE[second] ?? "google";
  }
  return IMPORT_DISTRIBUTIONS[head] ?? head.toLowerCase().replace(/_/g, "-");
}

export const pypiPackageManager: PackageManagerSpec = {
  ecosystem: "pypi",
  manifests: [
    {
      files: ["pyproject.toml"],
      async parse(text, file) {
        const pkgs = parsePyproject(text, file.declaredIn);
        const lock = (await file.readSibling("poetry.lock")) ?? (await file.readSibling("uv.lock"));
        return lock ? withLocked(pkgs, parseTomlPackageLock(lock)) : pkgs;
      },
      // `[project] name` (PEP 621) or Poetry's `[tool.poetry] name`.
      selfName: (text) => tomlSectionValue(text, ["project", "tool.poetry"], "name"),
    },
    {
      files: ["Pipfile"],
      async parse(text, file) {
        const lock = await file.readSibling("Pipfile.lock");
        return withLocked(parsePipfile(text, file.declaredIn), lock ? parsePipfileLock(lock) : null);
      },
    },
    {
      files: ["requirements*.txt", "**/requirements*.txt"],
      glob: { deep: 2, limit: 20 },
      // `requirements-dev.txt`, `test/requirements.txt`: tooling only.
      parse: (text, file) => parseRequirements(text, file.declaredIn, /dev|test/i.test(file.path)),
    },
  ],
  // `django.db.models` → `django`; `typing_extensions` is published as `typing-extensions`;
  // `yaml` is PyYAML's module, `PIL` Pillow's (see `IMPORT_DISTRIBUTIONS`).
  importKey: (s) => (s.startsWith(".") ? null : distributionOfImport(s)),
  packageKey: (name) => {
    const key = name.toLowerCase().replace(/[_.]/g, "-");
    return DISTRIBUTION_FAMILIES.get(key) ?? key;
  },
};
