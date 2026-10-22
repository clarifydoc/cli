import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * A resource API built from sub-resource locators and `@Path`-less super-interfaces
 * (real-repo FP: ~70 deployed endpoints missing, child routes emitted at bare paths).
 */
const API = "src/main/java/com/example/league/api";
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  [`${API}/SquadResource.java`]: `package com.example.league.api;
import javax.ws.rs.*;
public interface SquadResource {
  @Path("/{clubId}/players")
  PlayerResource getPlayerResource(@PathParam("clubId") String clubId);
  @POST @Path("/move/{id}")
  void move(@PathParam("id") String id);
}
`,
  [`${API}/ClubResource.java`]: `package com.example.league.api;
import javax.ws.rs.*;
@Path("/v1/clubs")
public interface ClubResource extends SquadResource {
  @GET @Path("/{id}")
  Club get(@PathParam("id") String id);
}
`,
  [`${API}/AcademyResource.java`]: `package com.example.league.api;
import javax.ws.rs.*;
@Path("/v1/academies")
public interface AcademyResource extends SquadResource {}
`,
  [`${API}/PlayerResource.java`]: `package com.example.league.api;
import javax.ws.rs.*;
public interface PlayerResource {
  @GET
  java.util.List<Player> list();
  @PUT @Path("/{playerId}")
  void update(@PathParam("playerId") String playerId, Player player);
  @Path("/{playerId}/injuries")
  InjuryResource getInjuryResource(@PathParam("playerId") String playerId);
}
`,
  [`${API}/InjuryResource.java`]: `package com.example.league.api;
import javax.ws.rs.*;
public interface InjuryResource {
  @POST
  void report(Injury injury);
}
`,
  [`${API}/RefereeEndpoint.java`]: `package com.example.league.api;
import javax.ws.rs.*;
public class RefereeEndpoint {
  @GET @Path("/done")
  public String done() { return "ok"; }
}
`,
};

describe("JAX-RS sub-resources", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-jaxrs-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serve locator and inherited routes under every resource that mounts them; an unmounted one keeps its own", () => {
    const rows = (summary.routeMap ?? []).filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path}`).sort();
    expect(rows).toEqual([
      "GET /done",
      "GET /v1/academies/{clubId}/players",
      "GET /v1/clubs/{clubId}/players",
      "GET /v1/clubs/{id}",
      "POST /v1/academies/move/{id}",
      "POST /v1/academies/{clubId}/players/{playerId}/injuries",
      "POST /v1/clubs/move/{id}",
      "POST /v1/clubs/{clubId}/players/{playerId}/injuries",
      "PUT /v1/academies/{clubId}/players/{playerId}",
      "PUT /v1/clubs/{clubId}/players/{playerId}",
    ]);
  });
});
