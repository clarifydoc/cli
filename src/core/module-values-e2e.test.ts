import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Paths and channels named by a constant another file declares — a Java and a
 * Kotlin constants class, a C# static class, a Python module, an Elixir
 * module's `topic/0` — take the value that file states, on both ends of a link.
 */
const FILES: Record<string, string> = {
  "java/src/main/java/com/acme/league/ApiPaths.java": `package com.acme.league;

public final class ApiPaths {
    public static final String CLUBS = "/api/v2/clubs";
    public static final String CLUB = CLUBS + "/{id}";
    public static final String TOPIC = "club-events";
}
`,
  "java/src/main/java/com/acme/league/ClubController.java": `package com.acme.league;

import org.springframework.web.bind.annotation.*;
import org.springframework.kafka.core.KafkaTemplate;

@RestController
public class ClubController {
    private KafkaTemplate<String, String> kafka;

    @GetMapping(ApiPaths.CLUB)
    public String club(@PathVariable String id) {
        kafka.send(ApiPaths.TOPIC, id);
        return id;
    }
}
`,
  "kotlin/src/main/kotlin/com/acme/garage/GaragePaths.kt": `package com.acme.garage

object GaragePaths {
    const val CARS = "/api/v1/cars"
}
`,
  "kotlin/src/main/kotlin/com/acme/garage/CarController.kt": `package com.acme.garage

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping(GaragePaths.CARS)
class CarController {
    @GetMapping("/{id}")
    fun car(@PathVariable id: String): String = id
}
`,
  "cs/League/ApiRoutes.cs": `namespace League.Api
{
    public static class ApiRoutes
    {
        public const string Matches = "api/v2/matches";
        public const string Match = Matches + "/{id:int}";
    }
}
`,
  "cs/League/MatchesController.cs": `using League.Api;
using Microsoft.AspNetCore.Mvc;

namespace League.Controllers
{
    [ApiController]
    public class MatchesController : ControllerBase
    {
        [HttpGet(ApiRoutes.Match)]
        public IActionResult Get(int id) => Ok();
    }
}
`,
  "cs/League/MatchClient.cs": `using System.Net.Http;
using League.Api;

namespace League.Clients
{
    public class MatchClient
    {
        private readonly HttpClient _http;
        public MatchClient(HttpClient http) { _http = http; }
        public async Task<string> Get(int id) => await _http.GetStringAsync($"/{ApiRoutes.Matches}/{id}");
    }
}
`,
  "cs/League/League.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`,
  "py/league/urls.py": `PLAYERS_URL = "/api/v2/players"

class Paths:
    SQUADS = "/api/v2/squads"
`,
  "py/league/views.py": `from flask import Flask
from league.urls import PLAYERS_URL
app = Flask(__name__)

@app.route(PLAYERS_URL + "/<int:player_id>")
def player(player_id):
    return {}
`,
  "py/league/client.py": `import requests
from league.urls import PLAYERS_URL, Paths

def get_player(player_id):
    return requests.get(f"{PLAYERS_URL}/{player_id}")

def list_squads():
    return requests.get(Paths.SQUADS)
`,
  "py/league/tables.py": `SQUAD_TABLE = "squad_members"
`,
  "py/league/squads.py": `from league.tables import SQUAD_TABLE

def add_member(cursor, row):
    cursor.execute("INSERT INTO " + SQUAD_TABLE + " (player_id) VALUES (%s)", row)
`,
  "ex/lib/league/standings.ex": `defmodule League.Standings do
  @topic "standings"

  def topic, do: @topic

  def publish(table) do
    Phoenix.PubSub.broadcast(League.PubSub, @topic, {:table, table})
  end
end
`,
  "ex/lib/league_web/live/table.ex": `defmodule LeagueWeb.TableLive do
  def mount(_params, _session, socket) do
    Phoenix.PubSub.subscribe(League.PubSub, League.Standings.topic())
    {:ok, socket}
  end
end
`,
};

describe("constants another file declares", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-module-values-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const routeAt = (file: string) => summary.routeMap.filter((r) => r.filePath === file).map((r) => `${r.httpMethod} ${r.path}`);

  it("reads a route path from a Java, Kotlin, C# or Python constant", () => {
    expect(routeAt("java/src/main/java/com/acme/league/ClubController.java")).toEqual(["GET /api/v2/clubs/{id}"]);
    expect(routeAt("kotlin/src/main/kotlin/com/acme/garage/CarController.kt")).toEqual(["GET /api/v1/cars/{id}"]);
    expect(routeAt("cs/League/MatchesController.cs")).toEqual(["GET /api/v2/matches/{id}"]);
    expect(routeAt("py/league/views.py")).toEqual(["GET /api/v2/players/<int:player_id>"]);
  });

  it("fills a call's URL from a C# or Python constant, and links it", () => {
    const calls = summary.apiCalls.filter((c) => c.filePath.startsWith("cs/") || c.filePath.startsWith("py/")).map((c) => c.target).sort();
    expect(calls).toEqual(["/api/v2/matches/{id}", "/api/v2/players/{player_id}", "/api/v2/squads"]);
    const linked = (summary.apiRouteLinks ?? []).map((l) => `${l.source} -> ${l.target}`).sort();
    expect(linked).toEqual(["cs/League/MatchClient.cs -> cs/League/MatchesController.cs", "py/league/client.py -> py/league/views.py"]);
  });

  it("names a table by a Python module value another file defines", () => {
    const rows = (summary.symbolDataAccess ?? []).filter((r) => r.file === "py/league/squads.py").map((r) => r.entity);
    expect(rows).toEqual(["squad_members"]);
  });

  it("names a channel by a Java constant or an Elixir module's topic function", () => {
    const channels = (summary.symbolDataAccess ?? []).filter((r) => r.access).map((r) => `${r.access} ${r.datastore}`).sort();
    expect(channels).toEqual(["queue-consume standings", "queue-publish club-events", "queue-publish standings"]);
  });
});
