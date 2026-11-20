import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses, extractFunctions } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { pythonRouteExtractor } from "./routes.js";
import { extractPythonModuleValues } from "./module-values.js";
import { pythonMeta } from "./meta.js";
import { fastapiSettingsPrefix } from "./settings-prefix.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import { resolveRouterMounts } from "../../shared/router-mounts.js";
import { buildImportIndex, resolveImportSource } from "../../../core/import-index.js";
import { buildClassIndex } from "../../../core/class-index.js";
import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

async function analyze(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "python" as never, filePath);
    const facts: RouteFact[] = [];
    const functions = extractFunctions(tree, src, "python" as never);
    // The pseudo-function the file analyzer makes for module-level statements, with their locals.
    const topLocals = pythonMeta.ast?.topLevelLocalTypes?.(tree, src) ?? [];
    if (topLocals.length > 0) functions.unshift({ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: 1, endLine: 1, localTypes: topLocals });
    out.push({
      filePath,
      language: "python",
      projectId: "root",
      imports: extractImports(tree, src, "python" as never),
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, "python" as never),
      functions,
      routes: pythonRouteExtractor.extractRoutes(tree, src, filePath, facts),
      dataSources: [],
      routeFacts: facts,
      moduleValues: extractPythonModuleValues(tree),
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const known = new Set(out.map((a) => a.filePath));
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(out, importIndex),
    resolveModule: (from, spec) => resolveImportSource(from, spec, known),
    fileOf: (p) => out.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(out, ctx, [fastapiSettingsPrefix]);
  resolveRouterMounts(out, importIndex);
  return out;
}

const rows = (files: FileAnalysis[]) =>
  files.flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path}`)).sort();

const ROUTER = {
  "league/api.py": `
from fastapi import APIRouter
router = APIRouter()

@router.get("/clubs")
def clubs():
    return []
`,
};
const SETTINGS = `
from pydantic import BaseSettings

class BaseLeagueSettings(BaseSettings):
    api_prefix: str = "/api"
    stadium_prefix: str

class LeagueSettings(BaseLeagueSettings):
    title: str = "League"
`;

describe("FastAPI prefix read from a settings value", () => {
  it("takes the literal default of the settings class, own or a base's, built in place", async () => {
    const files = await analyze({
      ...ROUTER,
      "league/settings.py": SETTINGS,
      "league/main.py": `
from fastapi import FastAPI
from league.api import router as api_router
from league.settings import LeagueSettings

settings = LeagueSettings()
app = FastAPI()
app.include_router(api_router, prefix=settings.api_prefix)
`,
    });
    expect(rows(files)).toEqual(["GET /api/clubs"]);
  });

  it("follows a function declaring the settings class it returns, and keeps two prefixes as two rows", async () => {
    const files = await analyze({
      ...ROUTER,
      "league/settings.py": SETTINGS + `
def get_settings() -> LeagueSettings:
    return LeagueSettings()
`,
      "league/main.py": `
from fastapi import FastAPI
from league.api import router as api_router
from league.settings import get_settings

def build():
    settings = get_settings()
    app = FastAPI()
    app.include_router(api_router, prefix=settings.api_prefix)
    app.include_router(api_router, prefix="/v2")
    return app
`,
    });
    expect(rows(files)).toEqual(["GET /api/clubs", "GET /v2/clubs"]);
  });

  it("reads an instance imported from the module that builds it", async () => {
    const files = await analyze({
      ...ROUTER,
      "league/settings.py": SETTINGS + "\nsettings = LeagueSettings()\n",
      "league/main.py": `
from fastapi import FastAPI
from league.api import router as api_router
from league.settings import settings

app = FastAPI()
app.include_router(api_router, prefix=settings.api_prefix)
`,
    });
    expect(rows(files)).toEqual(["GET /api/clubs"]);
  });

  it("leaves a prefix with no literal default unresolved, never guessed", async () => {
    const files = await analyze({
      ...ROUTER,
      "league/settings.py": SETTINGS,
      "league/main.py": `
from fastapi import FastAPI
from league.api import router as api_router
from league.settings import LeagueSettings

settings = LeagueSettings()
app = FastAPI()
app.include_router(api_router, prefix=settings.stadium_prefix)
`,
    });
    expect(rows(files)).toEqual(["GET /clubs"]);
  });

  it("leaves it unresolved when a subclass the instance may be states another value", async () => {
    const files = await analyze({
      ...ROUTER,
      "league/settings.py": SETTINGS + `
class CupSettings(LeagueSettings):
    api_prefix: str = "/cup"

def get_settings() -> LeagueSettings:
    return CupSettings()
`,
      "league/main.py": `
from fastapi import FastAPI
from league.api import router as api_router
from league.settings import get_settings

settings = get_settings()
app = FastAPI()
app.include_router(api_router, prefix=settings.api_prefix)
`,
    });
    expect(rows(files)).toEqual(["GET /clubs"]);
  });
});
