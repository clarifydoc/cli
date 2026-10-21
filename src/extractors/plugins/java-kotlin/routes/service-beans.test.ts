import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis, RouteFact } from "../../../../types/analysis.js";
import { collectServiceBeans } from "./service-beans.js";

/**
 * A CXF service whose resource interfaces come from a generated API jar
 * (real-repo FP: the service's whole REST surface had no route). Labels
 * written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId>
<dependencies><dependency><groupId>org.apache.cxf</groupId><artifactId>cxf-rt-frontend-jaxrs</artifactId></dependency>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></dependencies></project>`,
  "src/main/java/com/example/league/ApiConfiguration.java": `package com.example.league;

import com.example.league.api.MatchApi;
import com.example.league.api.ClubApi;
import org.apache.cxf.jaxrs.JAXRSServerFactoryBean;
import org.apache.cxf.endpoint.Server;

@Configuration
public class ApiConfiguration {
    @Bean
    public Server apiServer(MatchApi matchApi, ClubApi clubApi) {
        return endpoint("/", matchApi, clubApi).create();
    }

    private JAXRSServerFactoryBean endpoint(String address, Object... serviceBeans) {
        JAXRSServerFactoryBean endpoint = new JAXRSServerFactoryBean();
        endpoint.setServiceBeans(asList(serviceBeans));
        endpoint.setAddress(address);
        return endpoint;
    }
}
`,
  "src/main/java/com/example/league/api/MatchApiImpl.java": `package com.example.league.api;

import com.example.league.api.MatchApi;
import com.example.league.model.MatchDTO;
import com.example.league.db.MatchRepository;
import com.example.league.db.MatchEntity;
import org.springframework.stereotype.Service;

@Service
public class MatchApiImpl implements MatchApi {
    private final MatchRepository matchRepository;

    public MatchApiImpl(MatchRepository matchRepository) {
        this.matchRepository = matchRepository;
    }

    @Override
    public MatchDTO getMatch(String matchId) {
        return toDto(matchRepository.findById(matchId).orElseThrow());
    }

    @Override
    public void deleteMatch(String matchId) {
        matchRepository.deleteById(matchId);
    }

    @Override
    public String toString() {
        return "matches";
    }

    private MatchDTO toDto(MatchEntity e) {
        return new MatchDTO();
    }
}
`,
  "src/main/java/com/example/league/api/ClubApiImpl.java": `package com.example.league.api;

import com.example.league.api.ClubApi;

@Service
public class ClubApiImpl implements ClubApi {
    @Override
    public String getClubName(String clubId) {
        return clubId;
    }
}
`,
  "src/main/java/com/example/league/api/RefereeApiImpl.java": `package com.example.league.api;

import com.example.league.api.RefereeApi;

@Service
public class RefereeApiImpl implements RefereeApi {
    @Override
    public String getReferee(String id) {
        return id;
    }
}
`,
  "src/main/java/com/example/league/db/MatchEntity.java": `package com.example.league.db;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "matches")
public class MatchEntity {
    @Id
    private String id;
}
`,
  "src/main/java/com/example/league/db/MatchRepository.java": `package com.example.league.db;

import org.springframework.data.jpa.repository.JpaRepository;

public interface MatchRepository extends JpaRepository<MatchEntity, String> {
}
`,
};

describe("CXF service beans implementing a jar's API interfaces", () => {
  let dir: string;
  let summary: ProjectAnalysis;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cxf-beans-"));
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

  it("reads the registered types through a varargs wrapper", () => {
    const facts: RouteFact[] = [];
    collectServiceBeans(FILES["src/main/java/com/example/league/ApiConfiguration.java"]!, facts);
    expect(facts.map((f) => f.data)).toEqual([{ types: ["com.example.league.api.ClubApi", "com.example.league.api.MatchApi"] }]);
  });

  it("serves each overridden operation of a registered interface as a contract row", () => {
    const rows = summary.routeMap
      .filter((r) => r.prefixUnresolved?.startsWith("contract:"))
      .map((r) => `${r.path} ${r.contract?.type}#${r.contract?.method} ${(r.filePath ?? "").replace(/^.*\/api\//, "")}`)
      .sort();
    // RefereeApi is never registered; toString is Object's.
    expect(rows).toEqual([
      "ClubApi#getClubName com.example.league.api.ClubApi#getClubName ClubApiImpl.java",
      "MatchApi#deleteMatch com.example.league.api.MatchApi#deleteMatch MatchApiImpl.java",
      "MatchApi#getMatch com.example.league.api.MatchApi#getMatch MatchApiImpl.java",
    ]);
  });

  it("reaches the table from the implementing method", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect}`);
    expect(flows).toEqual(expect.arrayContaining(["MatchApi#getMatch db-read", "MatchApi#deleteMatch db-write"]));
  });
});
