import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A JPA association is a relation, not a supertype: `@ManyToOne Club club`
 * used to list `Club` in `Player.implements`, which drew a false `implements`
 * edge in the class graph.
 */
const FILES: Record<string, string> = {
  "pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  "src/main/java/com/example/league/Club.java": `package com.example.league;

import jakarta.persistence.*;
import java.util.List;

@Entity
public class Club {
    @Id
    private Long id;

    @OneToMany(mappedBy = "club")
    private List<Player> players;
}
`,
  "src/main/java/com/example/league/Player.java": `package com.example.league;

import jakarta.persistence.*;

@Entity
public class Player implements Comparable<Player> {
    @Id
    private Long id;

    @ManyToOne
    @JoinColumn(name = "club_id")
    private Club club;

    public int compareTo(Player other) { return 0; }
}
`,
};

describe("JPA relations stay out of implements", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const fileOf = async (rel: string): Promise<FileAnalysis> => JSON.parse(await readFile(join(dir, "out", `${rel}.json`), "utf8"));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-jpa-relations-"));
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

  it("keeps only the declared interface in implements; the association is an entity relation", async () => {
    const player = await fileOf("src/main/java/com/example/league/Player.java");
    expect(player.classes.find((c) => c.name === "Player")?.implements).toEqual(["Comparable<Player>"]);
    expect(player.entityRelations?.map((r) => `${r.fromEntity}.${r.fromField} -> ${r.toEntity}`)).toEqual(["Player.club -> Club"]);
    const club = await fileOf("src/main/java/com/example/league/Club.java");
    expect(club.classes.find((c) => c.name === "Club")?.implements).toEqual([]);
  });

  it("draws the association as a field edge in the class graph, never implements", () => {
    const g = summary.classGraph!;
    const name = (id: string) => g.nodes.find((n) => n.id === id)?.name;
    const edges = g.edges.map((e) => `${name(e.source)} ${Object.keys(e.byKind).join(",")} ${name(e.target)}`).sort();
    expect(edges).toEqual(["Club field Player", "Player field Club"]);
  });
});
