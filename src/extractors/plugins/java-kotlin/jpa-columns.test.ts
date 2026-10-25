import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * The JPA data model as the annotations state it (real-repo FP: `@Id` and
 * `@Column(name)` ignored, named-query constants listed as columns, a
 * `@MappedSuperclass` drawn as a table-less entity, and calls on a REST client
 * proxy counted as database access). Labels written by hand from the sources.
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId>
<dependencies><dependency><groupId>jakarta.persistence</groupId><artifactId>jakarta.persistence-api</artifactId></dependency></dependencies></project>`,
  "src/main/java/com/example/league/domain/TenantEntity.java": `package com.example.league.domain;

import jakarta.persistence.*;

@MappedSuperclass
public abstract class TenantEntity {
    @Id
    @Column(name = "id_")
    private Long id;

    @Column(name = "customer_id")
    private String customerId;
}
`,
  "src/main/java/com/example/league/domain/ClubEntity.java": `package com.example.league.domain;

import jakarta.persistence.*;

@Entity
@Table(name = "lg_club")
@NamedQuery(name = ClubEntity.FIND_BY_CITY, query = "select c from ClubEntity c where c.city = :city")
public class ClubEntity extends TenantEntity {
    public static final String FIND_BY_CITY = "club.by.city";

    @Column(name = "club_name")
    private String name;

    @Column
    private String city;
}
`,
  "src/main/java/com/example/league/domain/PlayerEntity.java": `package com.example.league.domain;

import jakarta.persistence.*;

@Entity
@Table(name = "lg_player")
public class PlayerEntity {
    @Id
    @Column(name = "player_id")
    private String playerId;

    @Column(name = "shirt_number")
    private int shirtNumber;
}
`,
  "src/main/java/com/example/league/api/ClubRepository.java": `package com.example.league.api;

import javax.ws.rs.*;

@Path("/v1/clubs")
public interface ClubRepository {
    @GET
    List<Club> findClubs(@QueryParam("city") String city);
}
`,
  "src/main/resources/client-context.xml": `<beans xmlns:jaxrs="http://cxf.apache.org/jaxrs">
  <jaxrs:client id="clubRepository" serviceClass="com.example.league.api.ClubRepository" address="http://localhost:8080/league"/>
</beans>
`,
  "src/main/java/com/example/league/scout/ScoutService.java": `package com.example.league.scout;

import com.example.league.api.ClubRepository;

public class ScoutService {
    @Autowired
    private ClubRepository clubRepository;

    public int countClubs(String city) {
        return clubRepository.findClubs(city).size();
    }
}
`,
};

describe("JPA columns, keys and bases; REST proxies are no database", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-jpa-columns-"));
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

  const columns = (name: string): string[] | undefined => summary.entityGraph?.nodes.find((n) => n.name === name)
    ?.columns.map((c) => `${c.name}${c.column ? `=${c.column}` : ""}${c.isPrimaryKey ? " pk" : ""}`);

  it("marks the @Id member as the key and names each @Column", () => {
    expect(columns("PlayerEntity")).toEqual(["playerId=player_id pk", "shirtNumber=shirt_number"]);
  });

  it("draws no node for a @MappedSuperclass; its columns are the subclass's, and a static constant is no column", () => {
    expect(summary.entityGraph?.nodes.map((n) => n.name).sort()).toEqual(["ClubEntity", "PlayerEntity"]);
    expect(columns("ClubEntity")).toEqual(["name=club_name", "city", "id=id_ pk", "customerId=customer_id"]);
  });

  it("records a call on a REST client proxy as the api-call only", () => {
    expect(summary.apiCalls.filter((c) => c.filePath.endsWith("ScoutService.java")).map((c) => c.name)).toEqual(["ClubRepository.findClubs"]);
    expect(JSON.stringify(summary.dataAccessGraph ?? {})).not.toContain("ScoutService");
  });
});
