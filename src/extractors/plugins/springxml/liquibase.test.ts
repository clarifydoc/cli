import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A Spring service whose schema lives in Liquibase changelogs (real-repo FP: migrations empty, 271 tables unseen). */
const NS = `xmlns="http://www.liquibase.org/xml/ns/dbchangelog"`;
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  "src/main/resources/db/changelog/db.changelog-master.xml": `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog ${NS}>
    <include file="changes/001-clubs.xml" relativeToChangelogFile="true"/>
    <include file="db/changelog/changes/002-matches.xml"/>
</databaseChangeLog>
`,
  "src/main/resources/db/changelog/changes/001-clubs.xml": `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog ${NS}>
    <changeSet id="1" author="league">
        <createTable tableName="league_club">
            <column name="club_id" type="uuid"><constraints primaryKey="true"/></column>
            <column name="name" type="varchar(80)"/>
        </createTable>
        <createTable tableName="league_tmp">
            <column name="id" type="int"/>
        </createTable>
    </changeSet>
</databaseChangeLog>
`,
  "src/main/resources/db/changelog/changes/002-matches.xml": `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog ${NS}>
    <changeSet id="2" author="league">
        <createTable tableName="league_match">
            <column name="match_id" type="uuid"/>
            <column name="home_club" type="uuid">
                <constraints references="league_club(club_id)" foreignKeyName="fk_match_home"/>
            </column>
        </createTable>
        <addColumn tableName="league_match">
            <column name="kick_off" type="timestamp"/>
        </addColumn>
        <renameColumn tableName="league_match" oldColumnName="match_id" newColumnName="id"/>
        <dropTable tableName="league_tmp"/>
        <createTable tableName="league_outbox">
            <column name="event_id" type="uuid"/>
        </createTable>
    </changeSet>
    <changeSet id="3" author="league">
        <sql><![CDATA[
            CREATE TABLE league_referee (
                referee_id uuid PRIMARY KEY,
                match_id uuid REFERENCES league_match(id)
            );
            ALTER TABLE league_outbox ADD COLUMN sent_at timestamp;
        ]]></sql>
        <sql>
            CREATE INDEX "IDX_MATCH_KICKOFF" ON "LEAGUE_MATCH" ("KICK_OFF")
        </sql>
        <sql>UPDATE league_match SET kick_off = NULL WHERE id &lt; 0</sql>
    </changeSet>
</databaseChangeLog>
`,
  "src/main/java/com/example/league/Club.java": `package com.example.league;

import jakarta.persistence.*;

@Entity
@Table(name = "league_club")
public class Club {
    @Id private String clubId;
}
`,
};

describe("Liquibase changelogs", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-liquibase-"));
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

  it("replay into the schema the master ends with, an entity standing for the table it maps", () => {
    const nodes = (summary.entityGraph?.nodes ?? []).map((n) => `${n.name} ${n.orm} ${n.columns.map((c) => c.name).join(",")}`).sort();
    expect(nodes).toEqual([
      "Club jpa clubId",
      "league_match liquibase id,home_club,kick_off",
      "league_outbox liquibase event_id,sent_at",
      "league_referee liquibase referee_id,match_id",
    ]);
    const edges = (summary.entityGraph?.edges ?? []).map((e) => [e.source.split("::").pop(), e.target.split("::").pop()].sort().join(" - ")).sort();
    expect(edges).toEqual(["Club - league_match", "league_match - league_referee"]);
  });

  it("are migrations", () => {
    expect((summary.migrations ?? []).filter((m) => m.ecosystem === "liquibase").map((m) => m.name)).toEqual(["001-clubs", "002-matches", "db.changelog-master"]);
  });
});
