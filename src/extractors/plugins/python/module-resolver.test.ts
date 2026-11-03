import { describe, it, expect } from "vitest";
import { resolvePythonImport } from "./module-resolver.js";
import type { ImportResolveContext } from "../../../types/language-plugin.js";

const ctx = (files: string[]): ImportResolveContext => ({
  files: new Set(files),
  declares: () => false,
  globImportsOf: () => [],
});

describe("resolvePythonImport", () => {
  const project = ctx([
    "clubs/__init__.py",
    "clubs/models.py",
    "players/__init__.py",
    "players/models.py",
    "players/views.py",
    "league/__init__.py",
    "league/base.py",
    "league/sub/__init__.py",
    "league/sub/fixtures.py",
    "cup/fixtures.py",
  ]);

  it("resolves a dotted module from the project root, the module before the name it binds", () => {
    expect(resolvePythonImport("players/views.py", "clubs.models", "Club", project)).toBe("clubs/models.py");
    expect(resolvePythonImport("cup/draw.py", "league.sub.fixtures", "load", project)).toBe("league/sub/fixtures.py");
  });

  it("takes `import a.b.c as x` to a/b/c.py and `from pkg import mod` to the module", () => {
    expect(resolvePythonImport("cup/replay.py", "league.sub.fixtures", "fx", project)).toBe("league/sub/fixtures.py");
    expect(resolvePythonImport("cup/final.py", "league.base", "league.base", project)).toBe("league/base.py");
    expect(resolvePythonImport("cup/derby.py", "league", "base", project)).toBe("league/base.py");
    expect(resolvePythonImport("cup/derby.py", "league", "Season", project)).toBe("league/__init__.py");
  });

  it("resolves relative imports beside and above the importer", () => {
    expect(resolvePythonImport("league/sub/fixtures.py", "..base", "Club", project)).toBe("league/base.py");
    expect(resolvePythonImport("league/schedule.py", ".sub", "fixtures", project)).toBe("league/sub/fixtures.py");
    expect(resolvePythonImport("league/schedule.py", ".", "base", project)).toBe("league/base.py");
  });

  it("names no file for a package or the standard library", () => {
    expect(resolvePythonImport("players/views.py", "fastapi", "APIRouter", project)).toBeNull();
    expect(resolvePythonImport("players/views.py", "typing", "Generic", project)).toBeNull();
  });
});

describe("resolvePythonImport — a module under another source root", () => {
  it("takes the one file whose path spells the dotted module, never a choice between two", () => {
    const roots = ctx(["src/league/__init__.py", "src/league/models.py", "web/e2e/seed.py", "src/utils.py"]);
    expect(resolvePythonImport("web/e2e/seed.py", "league.models", "Club", roots)).toBe("src/league/models.py");
    // A bare one-segment name names too much to guess.
    expect(resolvePythonImport("web/e2e/seed.py", "utils", "slug", roots)).toBeNull();
    const twins = ctx(["api/league/models.py", "worker/league/models.py", "web/e2e/seed.py"]);
    expect(resolvePythonImport("web/e2e/seed.py", "league.models", "Club", twins)).toBeNull();
  });
});
