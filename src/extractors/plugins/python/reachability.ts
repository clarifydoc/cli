import { readFile } from "fs/promises";
import { findShebangScripts, SCRIPT_DIRS } from "../shared/shebang-scripts.js";
import { join } from "path";
import type { FileAnalysis } from "../../../types/analysis.js";
import type {
  ReachabilityHooks,
  ReachabilityLoadContext,
  ReachabilityModel,
} from "../../../types/language-plugin.js";

/**
 * How Python finds modules — the model dead-code analysis walks.
 *
 * Imports name modules, and a module is a file (`pkg/mod.py`) or a package
 * (`pkg/__init__.py`); importing `a.b.c` runs `a/__init__.py` and
 * `a/b/__init__.py` on the way, so all of them are reached. The source root
 * an absolute import is relative to is never declared, so every ancestor of
 * the importer is tried, nearest first, then each project root and its `src/`.
 *
 * Python leans on conventions far more than JS does, and the model answers
 * them conservatively:
 *   - entry points: `if __name__ == "__main__"` scripts, `manage.py`/`wsgi.py`
 *     and friends, Django's auto-discovered modules (gated on Django), modules
 *     a server command names (`uvicorn app.main:app` in a Procfile, Dockerfile,
 *     compose file or Makefile) and console scripts in pyproject/setup.
 *   - dotted strings (`"proj.urls"`, `include("app.urls")`,
 *     `importlib.import_module("x.y")`) load modules: `module:` references.
 *   - a DISTRIBUTION (pyproject `[build-system]`, setup.py/setup.cfg) is a
 *     library whose every module a consumer may import, so its packages are
 *     public API and never reported — unless it is clearly a service (Django
 *     `manage.py`, a server command) or poetry's `package-mode = false`.
 *
 * Exports are not judged: an aliased `from x import y as z` keeps both names,
 * but attribute use through `import x` is the norm.
 */

const SCRIPT_BASENAME_RE = /(?:^|\/)(?:__main__|manage|wsgi|asgi)\.py$/;
/** Files a tool runs: never reported, never an anchor. */
const TOOL_BASENAME_RE = /(?:^|\/)(?:conftest|setup|noxfile|fabfile|tasks|celery|gunicorn\.conf|settings)\.py$/;
const APP_ENTRY_RE = /^(?:src\/)?(?:[^/]+\/)?(?:main|app|run|server|cli|worker|application)\.py$/;
const CONVENTION_DIR_RE =
  /(?:^|\/)(?:migrations|alembic|scripts|bin|tools|docs|examples|benchmarks|settings|management\/commands|templatetags)\//;
/** Modules Django discovers from INSTALLED_APPS / autodiscover, never by import. */
const DJANGO_RE = /(?:^|\/)(?:models|admin|apps|urls|tasks|signals|consumers|routing|checks)(?:\.py|\/)/;
/** A server/worker command that names the module it loads. */
const COMMAND_LINE_RE = /\b(?:uvicorn|gunicorn|hypercorn|daphne|granian|celery|flask|fastapi|rq|dramatiq|huey_consumer|python3?\s+-m)\b/;

export const pythonReachability: ReachabilityHooks = { load: loadPythonReachability };

async function loadPythonReachability(ctx: ReachabilityLoadContext): Promise<ReachabilityModel> {
  const files = ctx.files;
  const roots = [...new Set(["", ...ctx.roots])].sort((a, b) => b.length - a.length);
  const rootOf = (file: string): string => roots.find((r) => r === "" || file.startsWith(r + "/")) ?? "";
  const join2 = (a: string, b: string): string => normalize(a ? `${a}/${b}` : b);
  // Directories that exist, so "package `a` lives under this root" is checkable.
  const dirs = new Set<string>();
  for (const f of files) for (let d = dirOf(f); d; d = dirOf(d)) dirs.add(d);

  const moduleFiles = (path: string): string[] =>
    [`${path}.py`, `${path}/__init__.py`].map(normalize).filter((p) => files.has(p));
  /**
   * `a/b/c` under `root`: its files plus every `__init__.py` on the way down.
   * null when `root` does not hold package `a` (try the next root); [] when it
   * does but not the module.
   */
  const loadChain = (root: string, segs: readonly string[], specifiers: readonly string[]): string[] | null => {
    const top = join2(root, segs[0]!);
    if (!dirs.has(top) && !files.has(`${top}.py`)) return null;
    const out: string[] = [];
    for (let i = 1; i < segs.length; i++) {
      const init = join2(root, `${segs.slice(0, i).join("/")}/__init__.py`);
      if (files.has(init)) out.push(init);
    }
    const path = join2(root, segs.join("/"));
    const found = [...moduleFiles(path)];
    for (const s of specifiers) if (/^[A-Za-z_]\w*$/.test(s)) found.push(...moduleFiles(`${path}/${s}`));
    // The top package lives here but the module does not (an attribute path
    // like "app.views.index", or a stale import): this root answers nothing.
    if (found.length === 0) return [];
    return [...new Set([...out, ...found])];
  };
  const candidateRoots = (fromFile: string): string[] => {
    const out: string[] = [];
    for (let d = dirOf(fromFile); ; d = dirOf(d)) {
      out.push(d);
      if (!d) break;
    }
    for (const r of roots) out.push(r, join2(r, "src"));
    return [...new Set(out)];
  };
  /** An absolute dotted module from the first root that holds its top package. */
  const resolveAbsolute = (fromFile: string, dotted: string, specifiers: readonly string[]): string[] => {
    const segs = dotted.split(".");
    if (!segs.every((s) => /^[A-Za-z_]\w*$/.test(s))) return [];
    for (const root of candidateRoots(fromFile)) {
      const hit = loadChain(root, segs, specifiers);
      if (hit && hit.length > 0) return hit;
    }
    return [];
  };

  /** One import as Python executes it: the module, the `__init__`s on the way, imported submodules. */
  function resolveImport(fromFile: string, source: string, specifiers: readonly string[] = []): string[] {
    if (!source.startsWith(".")) return resolveAbsolute(fromFile, source, specifiers);
    // `from .mod import x` / `from .. import y`: relative to the package.
    const level = /^\.+/.exec(source)![0].length;
    let base = dirOf(fromFile);
    for (let i = 1; i < level; i++) base = dirOf(base);
    const rest = source.slice(level);
    const segs = rest ? rest.split(".") : [];
    const out: string[] = [];
    for (let i = 1; i < segs.length; i++) {
      const init = join2(base, `${segs.slice(0, i).join("/")}/__init__.py`);
      if (files.has(init)) out.push(init);
    }
    const path = segs.length > 0 ? join2(base, segs.join("/")) : base;
    if (segs.length > 0) out.push(...moduleFiles(path));
    for (const s of specifiers) if (/^[A-Za-z_]\w*$/.test(s)) out.push(...moduleFiles(join2(path, s)));
    return [...new Set(out)];
  }

  // ── Manifests and commands ──
  const manifestEntries: Array<{ file: string; reason: string }> = [];
  const publicRoots: string[] = [];
  const add = (root: string, dotted: string, reason: string): void => {
    for (const file of resolveAbsolute(`${root ? `${root}/` : ""}__root__.py`, dotted, [])) {
      manifestEntries.push({ file, reason });
    }
  };
  for (const root of roots) {
    const read = (name: string) => readText(join(ctx.projectRoot, root, name));
    const pyproject = await read("pyproject.toml");
    const setupPy = await read("setup.py");
    const setupCfg = await read("setup.cfg");
    // Console scripts and entry points: `name = "pkg.mod:func"`.
    for (const [text, reason] of [[pyproject, "pyproject.toml"], [setupPy, "setup.py"], [setupCfg, "setup.cfg"]] as const) {
      if (!text) continue;
      for (const m of text.matchAll(/([A-Za-z_][\w.]*):[A-Za-z_][\w.]*/g)) add(root, m[1]!, `${reason} entry point`);
    }
    let service = files.has(join2(root, "manage.py"));
    for (const name of ["Procfile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "Makefile", "start.sh", "entrypoint.sh", "run.sh"]) {
      const text = await read(name);
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (COMMAND_LINE_RE.test(line)) {
          service = true;
          for (const m of line.matchAll(/(?:^|[\s"'=])(?:-A\s+|--app[=\s]+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?::[A-Za-z_]\w*)?(?=$|[\s"',\]])/g)) {
            add(root, m[1]!, `${name} command`);
          }
        }
        for (const m of line.matchAll(/\bpython3?\s+(?!-)([\w./-]+\.py)\b/g)) {
          const file = join2(root, m[1]!);
          if (files.has(file)) manifestEntries.push({ file, reason: `${name} command` });
        }
      }
    }
    const distribution =
      (pyproject !== null && /^\s*\[build-system\]/m.test(pyproject) && !/package-mode\s*=\s*false/.test(pyproject)) ||
      setupPy !== null || (setupCfg !== null && /^\s*\[metadata\]/m.test(setupCfg));
    if (distribution && !service) publicRoots.push(root);
  }
  // Extension-less `#!/usr/bin/env python` scripts beside the code import it.
  const pyDirs = [
    ...[...files].filter((f) => f.endsWith(".py")).map(dirOf),
    ...roots.flatMap((r) => [r, ...SCRIPT_DIRS.map((d) => join2(r, d))]),
  ];
  for (const script of await findShebangScripts(ctx.projectRoot, pyDirs, /python/)) {
    for (const m of script.text.matchAll(/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n#]+)|import[ \t]+([^\n#]+))/gm)) {
      const imports = m[1] !== undefined
        ? [{ source: m[1], specifiers: m[2]!.replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!) }]
        : m[3]!.split(",").map((x) => ({ source: x.trim().split(/\s+as\s+/)[0]!, specifiers: [] as string[] }));
      for (const imp of imports) {
        for (const file of resolveImport(script.path, imp.source, imp.specifiers)) {
          manifestEntries.push({ file, reason: `script ${script.path}` });
        }
      }
    }
  }
  manifestEntries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.reason < b.reason ? -1 : 1));

  /** Inside a published package of a library: importable by its consumers. */
  const inPublishedPackage = (file: string): boolean => {
    const root = rootOf(file);
    if (!publicRoots.includes(root)) return false;
    const rel = root ? file.slice(root.length + 1) : file;
    const top = rel.replace(/^src\//, "").split("/")[0]!;
    const base = rel.startsWith("src/") ? join2(root, `src/${top}`) : join2(root, top);
    return files.has(`${base}/__init__.py`) || files.has(`${base}.py`);
  };

  return {
    manifestEntries,
    judgeExports: false,

    entryReason(analysis: FileAnalysis, relPath: string, frameworks: ReadonlySet<string>): string | null {
      const f = analysis.filePath;
      if (analysis.pathReferences?.includes("__main__")) return "script (`__main__` guard)";
      if (SCRIPT_BASENAME_RE.test(relPath)) return "conventional entry file";
      if (APP_ENTRY_RE.test(relPath)) return "conventional app entry";
      if (frameworks.has("django") && DJANGO_RE.test(relPath)) return "Django auto-discovered module";
      if (inPublishedPackage(f)) return "published package (library API)";
      return null;
    },

    passiveReason(_analysis: FileAnalysis, relPath: string): string | null {
      if (TOOL_BASENAME_RE.test(relPath)) return "run by a tool (pytest, setuptools, nox, settings)";
      if (CONVENTION_DIR_RE.test(relPath)) return "loaded by its tool (migrations, scripts, management commands)";
      return null;
    },

    isAmbient: (filePath) => filePath.endsWith(".pyi"),

    resolve: resolveImport,

    resolvePath(fromFile: string, ref: string): string[] {
      if (ref.startsWith("module:")) {
        // `"app.views.index"` names a module, then maybe an attribute in it:
        // the longest prefix that is a module wins.
        const segs = ref.slice(7).split(".");
        for (let n = segs.length; n >= 1; n--) {
          const hit = resolveAbsolute(fromFile, segs.slice(0, n).join("."), []);
          if (hit.length > 0) return hit;
        }
        return [];
      }
      if (ref.startsWith("file:")) {
        const p = ref.slice(5);
        const local = join2(dirOf(fromFile), p);
        if (files.has(local)) return [local];
        const rooted = join2(rootOf(fromFile), p);
        return files.has(rooted) ? [rooted] : [];
      }
      return [];
    },
  };
}

/**
 * Per-file: a `__main__` guard, dotted module strings and `.py` paths named
 * as data. Strings and comments are scanned as written — a false "reached"
 * only costs a missed finding.
 */
export function extractPythonPathReferences(sourceText: string): string[] {
  const out = new Set<string>();
  if (/^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(sourceText)) out.add("__main__");
  for (const m of sourceText.matchAll(/["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?::[A-Za-z_]\w*)?["']/g)) {
    out.add(`module:${m[1]}`);
  }
  for (const m of sourceText.matchAll(/["']((?:\.{1,2}\/)?[\w./-]+\.py)["']/g)) out.add(`file:${m[1]}`);
  return [...out];
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
