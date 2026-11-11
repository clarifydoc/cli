import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A route path named by a constant: the value the defining module states, or —
 * when nothing states it — never a guessed URL. The prefix alone would merge the
 * route into another (`@Get(ClubPaths.DETAIL)` read as `@Get()` shadowed the
 * list route's handler) and link calls to it.
 */
const FILES: Record<string, string> = {
  "nest/package.json": JSON.stringify({ name: "league-api", dependencies: { "@nestjs/common": "10.0.0", "@nestjs/core": "10.0.0" } }),
  "nest/src/paths.ts": `export const ClubPaths = { LIST: "", DETAIL: ":id" };
`,
  "nest/src/clubs.controller.ts": `import { Controller, Get, Delete } from "@nestjs/common";
import { ClubPaths } from "./paths";
import { Missing } from "./missing";
const PREFIXES = { legacy: "legacy" };

@Controller("clubs")
export class ClubsController {
  @Get()
  list() { return []; }

  @Get(ClubPaths.DETAIL)
  detail() { return {}; }

  @Get(["squad", "roster"])
  squad() { return []; }

  @Delete(Missing.GONE)
  gone() { return null; }
}

@Controller(PREFIXES.legacy)
export class LegacyController {
  @Get("cars")
  cars() { return []; }
}
`,
  "garage/package.json": JSON.stringify({ name: "garage-api", dependencies: { express: "4.18.0" } }),
  "garage/routes.js": `const ROUTES = { CARS: "/api/cars", CAR: "/api/cars/:id" };
module.exports = { ROUTES };
`,
  "garage/server.js": `const express = require("express");
const { ROUTES } = require("./routes");
const router = express.Router();
router.get(ROUTES.CARS, (req, res) => res.json([]));
router.delete(ROUTES.CAR, (req, res) => res.sendStatus(204));
router.post(UNKNOWN.PATH, (req, res) => res.sendStatus(201));
db.get(QUERY, [1], (err, row) => row);
const app = express();
app.use(router);
app.listen(3000);
`,
  "java/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>league</artifactId><version>1</version>
<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>
`,
  "java/src/main/java/com/example/league/Paths.java": `package com.example.league;
public final class Paths {
  public static final String BASE = "/api/clubs";
}
`,
  "java/src/main/java/com/example/league/web/ClubController.java": `package com.example.league.web;
import static com.example.league.Paths.BASE;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ClubController {
  @DeleteMapping(Missing.GONE)
  public void gone() {}
}

@RestController
class SquadController {
  @PutMapping(BASE + "/squad")
  public void squad() {}

  @PostMapping(Unknown.ROOT + "/transfers")
  public void transfer() {}
}
`,
  "kotlin/build.gradle.kts": `plugins { kotlin("jvm") version "1.9.0" }
dependencies { implementation("org.springframework.boot:spring-boot-starter-web:3.2.0") }
`,
  "kotlin/src/main/kotlin/com/example/league/Paths.kt": `package com.example.league
object Paths { const val BASE = "/api/teams" }
const val PLAYERS_ROOT = "/api/players"
`,
  "kotlin/src/main/kotlin/com/example/league/web/TeamController.kt": `package com.example.league.web
import com.example.league.*
import org.springframework.web.bind.annotation.*

@RestController
class TeamController {
  @GetMapping(Paths.BASE + "/players")
  fun players(): List<String> = emptyList()

  @GetMapping(PLAYERS_ROOT)
  fun all(): List<String> = emptyList()
}
`,
  "py/requirements.txt": "fastapi==0.110.0\n",
  "py/app/consts.py": `API_V1 = "/api/v1/matches"
`,
  "py/app/main.py": `from fastapi import APIRouter
from app.consts import API_V1
from app.missing import UNKNOWN_CONST

router = APIRouter()
SNAP = API_V1

@router.delete(UNKNOWN_CONST)
def gone():
    return None

@router.get(SNAP)
def matches():
    return []
`,
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.0.0" } }),
  "web/src/api.ts": `export async function removeClub() {
  return fetch("/clubs", { method: "DELETE" });
}
export async function loadMatches() {
  return fetch("/api/v1/matches");
}
const routes = { password: "/api/players/password" };
export class PlayerApi {
  constructor(private requests: { put(url: string, body: unknown): Promise<unknown> }) {}
  changePassword(payload: unknown) {
    return this.requests.put(routes.password, payload);
  }
}
`,
};

describe("route paths named by constants", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-route-templates-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const routes = (prefix: string) => summary.routeMap
    .filter((r) => r.kind === "api" && (r.filePath ?? "").startsWith(prefix))
    .map((r) => [
      r.httpMethod, r.path, r.handler,
      r.pathUnresolved ? `unresolved:${r.pathUnresolved.join(",")}` : null,
      r.prefixUnresolved ? `tail-of:${r.prefixUnresolved}` : null,
    ].filter(Boolean).join(" "))
    .sort();

  it("NestJS: a constant path, every alternative of an array, a prefix from a local table — and an unknown constant kept as a hole", () => {
    expect(routes("nest/")).toEqual([
      "DELETE /clubs/${Missing.GONE} gone unresolved:Missing.GONE",
      "GET /clubs list",
      "GET /clubs/:id detail",
      "GET /clubs/roster squad",
      "GET /clubs/squad squad",
      "GET /legacy/cars cars",
    ]);
  });

  it("Express: a route table's member is a path; a constant named like no path is no route", () => {
    expect(routes("garage/")).toEqual([
      "DELETE /api/cars/:id",
      "GET /api/cars",
      "POST /${UNKNOWN.PATH} unresolved:UNKNOWN.PATH",
    ]);
  });

  it("Java: a static import is read; an unknown constant is a hole, an unknown prefix leaves the tail", () => {
    expect(routes("java/")).toEqual([
      "DELETE /api/${Missing.GONE} gone unresolved:Missing.GONE",
      "POST /transfers transfer tail-of:constant:${Unknown.ROOT}",
      "PUT /api/clubs/squad squad",
    ]);
  });

  it("Kotlin: an object constant in a concatenation, a top-level const through a package wildcard", () => {
    expect(routes("kotlin/")).toEqual([
      "GET /api/players all",
      "GET /api/teams/players players",
    ]);
  });

  it("Python: a constant aliasing an imported one; an unknown constant is a hole, not its own name", () => {
    expect(routes("py/")).toEqual([
      "DELETE /${UNKNOWN_CONST} gone unresolved:UNKNOWN_CONST",
      "GET /api/v1/matches matches",
    ]);
  });

  it("a client request through a route table (`requests.put(routes.password, payload)`) is no route", () => {
    expect(routes("web/")).toEqual([]);
  });

  it("links a call to a resolved route, never to one whose URL is unknown", () => {
    const links = (summary.apiRouteLinks ?? []).map((l) => `${l.method ?? ""} ${l.url} -> ${l.target}:${l.targetLine}`);
    expect(links.some((l) => /\/api\/v1\/matches -> py\/app\/main\.py:12/.test(l))).toBe(true);
    // Before, `@Delete(Missing.GONE)` was `DELETE /clubs`, and the client's delete reached it.
    expect(links.filter((l) => l.includes("/clubs ->"))).toEqual([]);
  });
});
