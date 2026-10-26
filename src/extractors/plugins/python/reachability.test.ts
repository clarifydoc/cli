import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pythonReachability, extractPythonPathReferences } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function model(files: string[], disk: Record<string, string> = {}, roots: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-py-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(disk)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    if (body.startsWith("#!")) chmodSync(join(root, path), 0o755);
  }
  return pythonReachability.load({ projectRoot: root, roots, files: new Set(files) });
}
const analysis = (filePath: string, pathReferences?: string[]) =>
  ({ filePath, pathReferences }) as unknown as FileAnalysis;

describe("Python path references", () => {
  it("captures the __main__ guard, dotted module strings and .py paths", () => {
    const refs = extractPythonPathReferences(`
ROOT_URLCONF = "proj.urls"
mod = importlib.import_module('app.plugins.csv')
APP = "app.main:app"
VERSION = "1.2.3"
subprocess.run(["python", "scripts/seed.py"])

if __name__ == "__main__":
    main()
`);
    expect(refs).toEqual([
      "__main__", "module:proj.urls", "module:app.plugins.csv", "module:app.main", "file:scripts/seed.py",
    ]);
  });
});

describe("Python reachability model", () => {
  const files = [
    "app/__init__.py", "app/main.py", "app/api/__init__.py", "app/api/routes.py",
    "app/db/__init__.py", "app/db/session.py", "app/core/config.py",
  ];

  it("runs every package __init__ on the way to an absolute import", async () => {
    const m = await model(files);
    expect(m.resolve("app/main.py", "app.db.session", ["SessionLocal"])).toEqual([
      "app/__init__.py", "app/db/__init__.py", "app/db/session.py",
    ]);
    // `from app.api import routes` loads the routes submodule too.
    expect(m.resolve("app/main.py", "app.api", ["routes"])).toEqual([
      "app/__init__.py", "app/api/__init__.py", "app/api/routes.py",
    ]);
    // A namespace package (no __init__) still resolves its module.
    expect(m.resolve("app/main.py", "app.core.config", [])).toEqual(["app/__init__.py", "app/core/config.py"]);
    // Third-party: nothing local.
    expect(m.resolve("app/main.py", "fastapi", ["FastAPI"])).toEqual([]);
    expect(m.judgeExports).toBe(false);
  });

  it("resolves relative imports from the importer's package", async () => {
    const m = await model(files);
    expect(m.resolve("app/api/routes.py", "..db.session", [])).toEqual(["app/db/__init__.py", "app/db/session.py"]);
    expect(m.resolve("app/api/routes.py", ".", ["__init__"])).toEqual(["app/api/__init__.py"]);
    expect(m.resolve("app/main.py", ".api", ["routes"])).toEqual(["app/api/__init__.py", "app/api/routes.py"]);
  });

  it("reads entry points from server commands, console scripts and shebang scripts", async () => {
    const m = await model(
      [...files, "app/worker.py", "app/cli.py", "app/jobs/nightly.py"],
      {
        Procfile: "web: uvicorn app.main:app --port 8000\nworker: celery -A app.worker worker\n",
        "pyproject.toml": '[project]\nname = "x"\n[project.scripts]\nx = "app.cli:main"\n',
        "bin/nightly": "#!/usr/bin/env python3\nfrom app.jobs.nightly import run\nrun()\n",
      },
    );
    const entries = m.manifestEntries.map((e) => `${e.file} ← ${e.reason}`);
    expect(entries).toContain("app/main.py ← Procfile command");
    expect(entries).toContain("app/worker.py ← Procfile command");
    expect(entries).toContain("app/cli.py ← pyproject.toml entry point");
    expect(entries).toContain("app/jobs/nightly.py ← script bin/nightly");
  });

  it("treats a published library's modules as public API, unless it is a service", async () => {
    const lib = await model(["mylib/__init__.py", "mylib/rarely_used.py", "scripts/old.py"], {
      "pyproject.toml": '[build-system]\nrequires = ["hatchling"]\n[project]\nname = "mylib"\n',
    });
    expect(lib.entryReason(analysis("mylib/rarely_used.py"), "mylib/rarely_used.py", new Set())).toBe("published package (library API)");

    const service = await model(["svc/__init__.py", "svc/stale.py", "manage.py"], {
      "pyproject.toml": '[build-system]\nrequires = ["poetry-core"]\n[project]\nname = "svc"\n',
      "manage.py": "",
    });
    expect(service.entryReason(analysis("svc/stale.py"), "svc/stale.py", new Set())).toBeNull();
  });

  it("knows Python and Django conventions, the latter only under Django", async () => {
    const m = await model([]);
    const none = new Set<string>();
    expect(m.entryReason(analysis("tool.py", ["__main__"]), "tool.py", none)).toBe("script (`__main__` guard)");
    expect(m.entryReason(analysis("manage.py"), "manage.py", none)).toBe("conventional entry file");
    // A migration is run by its tool: alive, but it anchors nothing.
    expect(m.entryReason(analysis("shop/migrations/0001_initial.py"), "shop/migrations/0001_initial.py", none)).toBeNull();
    expect(m.passiveReason?.(analysis("shop/migrations/0001_initial.py"), "shop/migrations/0001_initial.py", none)).toMatch(/tool/);
    expect(m.passiveReason?.(analysis("conftest.py"), "conftest.py", none)).toMatch(/tool/);
    expect(m.entryReason(analysis("shop/admin.py"), "shop/admin.py", none)).toBeNull();
    expect(m.entryReason(analysis("shop/admin.py"), "shop/admin.py", new Set(["django"]))).toBe("Django auto-discovered module");
  });

  it("resolves dotted strings to the longest module prefix", async () => {
    const m = await model(files);
    expect(m.resolvePath("app/main.py", "module:app.api.routes.router")).toEqual([
      "app/__init__.py", "app/api/__init__.py", "app/api/routes.py",
    ]);
    expect(m.resolvePath("app/main.py", "module:django.contrib.admin")).toEqual([]);
  });

  it("keeps modules a registry, a package loader or a lazy __getattr__ table names", async () => {
    const pkg = ["league/__init__.py", "league/cli/__init__.py", "league/cli/main.py", "league/cli/commands/__init__.py",
      "league/cli/commands/fixtures_cmd.py", "league/sections/__init__.py", "league/sections/table.py", "league/sections/form.py",
      "league/squad/__init__.py", "league/squad/_squad_utils.py"];
    const m = await model(pkg);
    const registry = extractPythonPathReferences(`_COMMANDS_PKG = "league.cli.commands"
_COMMANDS = (("fixtures", "fixtures_cmd:fixtures_group"),)
for name, target in _COMMANDS:
    register(name, f"{_COMMANDS_PKG}.{target}")
`);
    expect(registry.flatMap((r) => m.resolvePath("league/cli/main.py", r))).toContain("league/cli/commands/fixtures_cmd.py");
    const loader = extractPythonPathReferences(`import pkgutil, importlib\nfor mod in pkgutil.iter_modules(__path__):\n    importlib.import_module(f"{__name__}.{mod.name}")\n`);
    expect(loader.flatMap((r) => m.resolvePath("league/sections/__init__.py", r)).sort()).toEqual(["league/sections/form.py", "league/sections/table.py"]);
    const lazy = extractPythonPathReferences(`from importlib import import_module
_LAZY = {"SquadUtils": "._squad_utils"}

def __getattr__(name):
    return getattr(import_module(_LAZY[name], __name__), name)
`);
    expect(lazy.flatMap((r) => m.resolvePath("league/squad/__init__.py", r))).toContain("league/squad/_squad_utils.py");
  });
});
