import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** Write `files` under a fresh directory, analyze it, and return the summary. */
async function analyzed(dir: string, files: Record<string, string>) {
  const root = join(dir, "project");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return loadReportSummary(join(dir, "out"));
}

describe("facts a client call, a library name or a package import used to invent, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-wrong-facts-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("Go: `http.Post(base+…)` is a request to gin's route, never a route that displaces it", async () => {
    const s = await analyzed(join(dir, "go"), {
      "go.mod": "module example.com/league\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.0\n",
      "client.go": 'package main\n\nimport "net/http"\n\nfunc notifyLeague(base string) error {\n\t_, err := http.Post(base+"/v1/clubs", "application/json", nil)\n\treturn err\n}\n',
      "main.go": 'package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc createClub(c *gin.Context) {}\n\nfunc main() {\n\tr := gin.Default()\n\tv1 := r.Group("/v1")\n\tv1.POST("/clubs", createClub)\n\tr.Run()\n}\n',
    });
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.filePath} ${r.handler}`)).toEqual(["POST /v1/clubs main.go createClub"]);
    expect(s.apiRouteLinks?.map((l) => `${l.source} ${l.method} ${l.routePath} ${l.handler}`)).toEqual(["client.go POST /v1/clubs createClub"]);
  });

  it("TypeScript: an axios instance named `http` keeps its baseURL", async () => {
    const s = await analyzed(join(dir, "ts"), {
      "package.json": JSON.stringify({ name: "fixtures", dependencies: { axios: "1.6.0", express: "4.18.0" } }),
      "src/http.ts": "import axios from 'axios';\nexport const http = axios.create({ baseURL: '/v2' });\n",
      "src/fixtures.ts": "import { http } from './http';\nexport function saveFixture() { return http.post('/fixtures', {}); }\n",
      "src/server.ts": "import express from 'express';\nconst app = express();\napp.post('/v1/fixtures', saveV1);\napp.post('/v2/fixtures', saveV2);\n",
    });
    expect(s.apiRouteLinks?.map((l) => `${l.url} ${l.routePath} ${l.confidence}`)).toEqual(["/v2/fixtures /v2/fixtures EXTRACTED"]);
  });

  it("Python: a package's or the standard library's name never binds a project namesake", async () => {
    const s = await analyzed(join(dir, "py"), {
      "pyproject.toml": '[project]\nname = "league"\ndependencies = ["pydantic", "django"]\n',
      "league/__init__.py": "",
      "league/core.py": "class BaseModel:\n    def dict(self):\n        return {}\n\nclass Model:\n    def save(self):\n        pass\n",
      "league/types.py": "def SimpleNamespace(**kw):\n    return kw\n",
      "league/club.py": [
        "from pydantic import BaseModel",
        "from django.db.models import Model",
        "import types",
        "",
        "class Club(BaseModel):",
        "    name: str",
        "",
        "class Player(Model):",
        "    def persist(self):",
        "        self.save()",
        "",
        "def run():",
        '    c = Club(name="x")',
        "    c.dict()",
        "    return types.SimpleNamespace(a=1)",
        "",
      ].join("\n"),
    });
    const fromClub = (s.symbolLinks ?? []).filter((l) => l.sourceFile === "league/club.py" && l.targetFile !== "league/club.py" && l.relation !== "reference");
    expect(fromClub.map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)).toEqual([]);
    expect(s.componentGraph["league/club.py"] ?? []).toEqual([]);
    const extendsEdges = (s.classGraph?.edges ?? []).filter((e) => e.byKind.extends);
    expect(extendsEdges.map((e) => e.target)).not.toContain("league/core.py::BaseModel");
    expect(extendsEdges.map((e) => e.target)).not.toContain("league/core.py::Model");
  });
});
