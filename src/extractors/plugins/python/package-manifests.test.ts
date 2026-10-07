import { describe, it, expect } from "vitest";
import { pypiPackageManager } from "./package-manifests.js";

const pyproject = pypiPackageManager.manifests.find((m) => m.files.includes("pyproject.toml"))!;
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
    expect(deps).toEqual(["psycopg@dev", "mkdocs@dev"]);
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
