import { describe, it, expect } from "vitest";
import { PytestFixtureResolver } from "./pytest-fixtures.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const fn = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 1, endLine: 3, ...extra });
const call = (name: string, line = 2) => ({ name, kind: "internal", target: null, line });
const param = (name: string, type: string | null = null) => ({ name, type, defaultValue: null });
const file = (filePath: string, functions: unknown[], classes: unknown[] = []) =>
  ({ filePath, language: "python", functions, classes, imports: [], exports: [] }) as unknown as FileAnalysis;
const cls = (name: string, methods: string[], ext: string | null = null) =>
  ({ name, extends: ext, implements: [], decorators: [], properties: [], methods: methods.map((m, i) => fn(m, { line: 10 + i })) });

describe("pytest fixtures", () => {
  it("types a test's parameter by the fixture of that name — its module first, then the nearest conftest.py", () => {
    const models = file("app/models.py", [], [cls("Base", ["ping"]), cls("Player", ["save"], "Base"), cls("Admin", ["grant"])]);
    const rootConftest = file("tests/conftest.py", [
      fn("player", { decorators: ["pytest.fixture"], returnType: "Player" }),
      fn("admin_gen", { decorators: ['pytest.fixture(name="admin")'], returnType: "Iterator[Admin]" }),
    ]);
    const deeper = file("tests/api/conftest.py", [fn("player", { decorators: ["fixture"], returnType: "Admin" })]);
    const test = file("tests/test_players.py", [
      fn("test_save", { params: [param("player"), param("typed", "Other")], calls: [call("player.save"), call("player.ping"), call("player.missing"), call("typed.save")] }),
      fn("test_admin", { params: [param("admin")], calls: [call("admin.grant")] }),
      fn("helper", { params: [param("player")], calls: [call("player.save")] }),
    ]);
    const apiTest = file("tests/api/test_api.py", [fn("test_it", { params: [param("player")], calls: [call("player.grant")] })]);
    const links = new PytestFixtureResolver().resolve([models, rootConftest, deeper, test, apiTest]);
    expect(links.map((l) => [l.sourceFile, l.sourceSymbol, l.callName, l.targetSymbol])).toEqual([
      ["tests/test_players.py", "test_save", "player.save", "Player.save"],
      ["tests/test_players.py", "test_save", "player.ping", "Base.ping"],
      ["tests/test_players.py", "test_admin", "admin.grant", "Admin.grant"],
      ["tests/api/test_api.py", "test_it", "player.grant", "Admin.grant"],
    ]);
  });
});
