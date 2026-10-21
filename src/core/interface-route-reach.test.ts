import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Routes declared on a JAX-RS interface in an API module, implemented once in
 * the service module (real-repo FP: no route of four services reached a table).
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId><modules><module>league-api</module><module>league-service</module></modules></project>`,
  "league-api/pom.xml": `<project><groupId>com.example</groupId><artifactId>league-api</artifactId></project>`,
  "league-api/src/main/java/com/example/league/api/ClubResource.java": `package com.example.league.api;

import javax.ws.rs.*;

@Path("/v1/clubs")
public interface ClubResource {
    @GET
    Object getClubs();

    @DELETE
    @Path("{id}")
    void deleteClub(@PathParam("id") String id);
}
`,
  "league-service/pom.xml": `<project><groupId>com.example</groupId><artifactId>league-service</artifactId></project>`,
  "league-service/src/main/java/com/example/league/service/ClubResourceImpl.java": `package com.example.league.service;

import com.example.league.api.ClubResource;
import javax.persistence.EntityManager;

public class ClubResourceImpl implements ClubResource {
    private EntityManager em;

    @Override
    public Object getClubs() {
        return em.createQuery("select c from Club c").getResultList();
    }

    @Override
    public void deleteClub(String id) {
        em.remove(em.find(Club.class, id));
    }
}
`,
  "league-service/src/main/java/com/example/league/service/Club.java": `package com.example.league.service;

import javax.persistence.*;

@Entity
@Table(name = "clubs")
public class Club {
    @Id private String id;
}
`,
};

describe("routes on an interface with one implementation", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-interface-routes-"));
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

  it("reach the tables their implementation reaches", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.resource}`).sort();
    expect(flows).toEqual(["DELETE /v1/clubs/{id} Club", "GET /v1/clubs Club"]);
  });
});
