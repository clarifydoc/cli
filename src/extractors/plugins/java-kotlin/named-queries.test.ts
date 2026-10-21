import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { namedQueryDeclarations } from "./entities.js";

/** JPA named queries declared on entities, run elsewhere by name (real-repo FP: 155 sites with no entity). */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  "src/main/java/com/example/league/Match.java": `package com.example.league;

import javax.persistence.*;

@Entity
@Table(name = "matches")
@NamedQueries({
    @NamedQuery(name = "match.count.by.club", query = "select count(m) from Match m " +
        "where m.club = :club"),
    @NamedQuery(name = "match.players", query = "select p from Player p where p.match = :m")
})
public class Match {
    @Id private Long id;
}
`,
  "src/main/java/com/example/league/Player.java": `package com.example.league;

import javax.persistence.*;

@Entity
@NamedNativeQuery(name = "player.raw", query = "SELECT * FROM players", resultClass = Player.class)
public class Player {
    @Id private Long id;
}
`,
  "src/main/resources/META-INF/orm.xml": `<?xml version="1.0" encoding="UTF-8"?>
<entity-mappings xmlns="http://xmlns.jcp.org/xml/ns/persistence/orm" version="2.1">
    <named-query name="club.matches">
        <query><![CDATA[
            select m from Match m where m.club = :club
        ]]></query>
    </named-query>
    <entity class="com.example.league.Player">
        <named-native-query name="player.retired"><query>SELECT * FROM players WHERE retired</query></named-native-query>
    </entity>
</entity-mappings>
`,
  "src/main/java/com/example/league/MatchService.java": `package com.example.league;

import javax.persistence.EntityManager;

public class MatchService {
    private EntityManager em;

    public Long countMatches(Object club) {
        return em.createNamedQuery("match.count.by.club", Long.class).setParameter("club", club).getSingleResult();
    }

    public Object players(Object m) {
        return em.createNamedQuery("match.players").setParameter("m", m).getResultList();
    }

    public Object raw() {
        return em.createNamedQuery("player.raw").getResultList();
    }

    public Object clubMatches(Object club) {
        return em.createNamedQuery("club.matches").setParameter("club", club).getResultList();
    }

    public Object retired() {
        return em.createNamedQuery("player.retired").getResultList();
    }

    public Object unknown() {
        return em.createNamedQuery("season.all").getResultList();
    }
}
`,
};

describe("JPA named queries", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-named-queries-"));
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

  it("reads each declaration's name and the entity its query reads", () => {
    expect(namedQueryDeclarations('NamedQueries({ @NamedQuery(name = "a", query = "select m from Match m"), @NamedQuery(name = "b", query = "select 1") })', "Match"))
      .toEqual([{ name: "a", entity: "Match" }, { name: "b", entity: "Match" }]);
  });

  it("gives the call running a named query the entity it reads", () => {
    const rows = (summary.symbolDataAccess ?? [])
      .filter((r) => r.symbol.startsWith("MatchService."))
      .map((r) => `${r.symbol} ${r.entity ?? "-"}`)
      .sort();
    expect(rows).toEqual(expect.arrayContaining([
      "MatchService.countMatches Match",
      "MatchService.players Player",
      "MatchService.raw Player",
      "MatchService.clubMatches Match",
      "MatchService.retired Player",
    ]));
    expect(rows.some((r) => r.startsWith("MatchService.unknown") && !r.endsWith(" -"))).toBe(false);
  });
});
