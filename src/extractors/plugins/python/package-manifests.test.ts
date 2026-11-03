import { describe, it, expect } from "vitest";
import { parseRequirement, pypiPackageManager } from "./package-manifests.js";

const pyproject = pypiPackageManager.manifests.find((m) => m.files.includes("pyproject.toml"))!;
const requirements = pypiPackageManager.manifests.find((m) => m.files.includes("requirements*.txt"))!;
const withVersions = async (text: string, manifest = pyproject, path = "pyproject.toml") =>
  (await manifest.parse(text, { declaredIn: path, path, readSibling: async () => null })).map(
    (p) => `${p.name}@${p.scope}${p.version ? ` ${p.version}` : ""}`,
  );
const parse = async (text: string) =>
  (await pyproject.parse(text, { declaredIn: "pyproject.toml", path: "pyproject.toml", readSibling: async () => null })).map(
    (p) => `${p.name}@${p.scope}`,
  );

describe("pyproject.toml", () => {
  it("reads every PEP 621 dependency, extras brackets included", async () => {
    const deps = await parse(
      ["[project]", "dependencies = [", '  "celery[redis]~=5.5.1",', '  "django~=5.2.13",', '  "drf-spectacular",', "]"].join("\n"),
    );
    expect(deps).toEqual(["celery@prod", "django@prod", "drf-spectacular@prod"]);
  });

  it("reads a one-line array", async () => {
    expect(await parse(['[project]', 'dependencies = ["fastapi>=0.110", "uvicorn[standard]"]'].join("\n"))).toEqual([
      "fastapi@prod",
      "uvicorn@prod",
    ]);
  });

  it("reads optional-dependencies groups as their packages, not their group names", async () => {
    const deps = await parse(
      ["[project.optional-dependencies]", 'postgres = ["psycopg[c,pool]==3.2.12"]', "docs = [", '  "mkdocs",', "]"].join("\n"),
    );
    expect(deps).toEqual(["psycopg@optional", "mkdocs@optional"]);
  });

  it("still reads Poetry tables", async () => {
    const deps = await parse(
      ["[tool.poetry.dependencies]", 'python = "^3.11"', 'django = "^5.0"', "", "[tool.poetry.group.dev.dependencies]", 'pytest = "^8"'].join(
        "\n",
      ),
    );
    expect(deps).toEqual(["django@prod", "pytest@dev"]);
  });
});

describe("PEP 508 requirements", () => {
  it("reads markers, parenthesized specs, extras and URL references", () => {
    expect(parseRequirement("tomli ; python_version < '3.11'")).toEqual({ name: "tomli", version: null });
    expect(parseRequirement("pydantic (>=2.0)")).toEqual({ name: "pydantic", version: ">=2.0" });
    expect(parseRequirement("anyio (>=4,<5)")).toEqual({ name: "anyio", version: ">=4,<5" });
    expect(parseRequirement("club-stats[fast]>=1.2; sys_platform != 'win32'")).toEqual({ name: "club-stats", version: ">=1.2" });
    expect(parseRequirement("league-kit @ git+https://example.com/league/league-kit.git")).toEqual({ name: "league-kit", version: null });
    expect(parseRequirement("Django Rest")).toBeNull();
  });

  it("reads every array entry of [project], whatever its quotes hold", async () => {
    const deps = await withVersions(
      [
        "[project]",
        'name = "league-app"',
        "dependencies = [",
        `  "tomli ; python_version < '3.11'",`,
        '  "pydantic (>=2.0)",',
        '  "league-kit @ git+https://example.com/league/league-kit.git",  # pinned to main',
        '  "requests (>=2.32,<3.0)",',
        "]",
      ].join("\n"),
    );
    expect(deps).toEqual(["tomli@prod", "pydantic@prod >=2.0", "league-kit@prod", "requests@prod >=2.32,<3.0"]);
  });

  it("scopes each table: dependency groups, uv and Hatch tooling are dev, a Hatch env is never prod", async () => {
    const deps = await withVersions(
      [
        "[dependency-groups]",
        'test = ["pytest>=8", {include-group = "lint"}]',
        'lint = ["ruff"]',
        "[tool.uv]",
        'dev-dependencies = ["mypy>=1.10"]',
        "[tool.hatch.envs.default]",
        'dependencies = ["coverage[toml]"]',
        "[tool.ruff]",
        'dependencies = ["not-a-package"]',
      ].join("\n"),
    );
    expect(deps).toEqual(["pytest@dev >=8", "ruff@dev", "mypy@dev >=1.10", "coverage@dev"]);
  });

  it("reads a Poetry subtable as the one package it names, and Poetry 1 dev and named groups", async () => {
    const deps = await withVersions(
      [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        '"zope.interface" = "^6"',
        'tyres = { version = "^2.1", optional = true }',
        "[tool.poetry.dependencies.httpx]",
        'version = "^0.27"',
        "optional = false",
        "[tool.poetry.dev-dependencies]",
        'black = "^24"',
        "[tool.poetry.group.main.dependencies]",
        'engine-core = "^1"',
        "[tool.poetry.group.test.dependencies]",
        'pytest-cov = "^5"',
      ].join("\n"),
    );
    expect(deps).toEqual([
      "zope.interface@prod ^6",
      "tyres@optional ^2.1",
      "httpx@prod ^0.27",
      "black@dev ^24",
      "engine-core@prod ^1",
      "pytest-cov@dev ^5",
    ]);
  });

  it("joins continued requirement lines and drops pip options and comments", async () => {
    const deps = await withVersions(
      [
        "# pinned",
        "gearbox==1.4.2 \\",
        "    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000",
        'pitstop[async] (>=3.1) ; python_version >= "3.9"',
        "paddock @ git+https://example.com/paddock.git#egg=paddock",
        "-r requirements-dev.txt",
      ].join("\n"),
      requirements,
      "requirements.txt",
    );
    expect(deps).toEqual(["gearbox@prod ==1.4.2", "pitstop@prod >=3.1", "paddock@prod"]);
  });
});
