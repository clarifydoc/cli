import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A Spring service whose base URL is a `@Value` property set in application.yml, the host a compose service. */
const FILES: Record<string, string> = {
  "docker-compose.yml": `services:
  fixtures:
    build: ./fixtures
  clubs:
    build: ./clubs
    ports: ["8081:8080"]
`,
  "fixtures/pom.xml": "<project><artifactId>fixtures</artifactId></project>\n",
  "fixtures/src/main/resources/application.yml": `clubs:
  service:
    url: \${CLUBS_URL:http://clubs:8080}
`,
  "fixtures/src/main/java/com/example/league/fixtures/ClubLookup.java": `package com.example.league.fixtures;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class ClubLookup {
    private final RestTemplate restTemplate = new RestTemplate();

    @Value("\${clubs.service.url}")
    private String clubsUrl;

    public Club find(long id) {
        return restTemplate.getForObject(clubsUrl + "/api/clubs/" + id, Club.class);
    }
}
`,
  "clubs/pom.xml": "<project><artifactId>clubs</artifactId></project>\n",
  "clubs/src/main/java/com/example/league/clubs/ClubController.java": `package com.example.league.clubs;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/clubs")
public class ClubController {
    @GetMapping("/{id}")
    public Club get(@PathVariable long id) { return null; }
}
`,
};

describe("a Spring base URL from application.yml", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-spring-origin-"));
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

  it("takes the call to the service the property names", () => {
    const call = summary.apiCalls!.find((c) => c.filePath.endsWith("ClubLookup.java"))!;
    expect(call.baseRef).toEqual({ kind: "config", key: "clubs.service.url" });
    expect(call.origin?.project).toBe(summary.subProjects!.find((p) => p.root === "clubs")!.id);
    const link = summary.apiRouteLinks!.find((l) => l.source.endsWith("ClubLookup.java"))!;
    expect(link.target).toBe("clubs/src/main/java/com/example/league/clubs/ClubController.java");
  });
});
