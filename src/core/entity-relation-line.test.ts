import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * An entity relation names its source entity by name and states the line its declaring class starts on
 * (`EntityRelation.fromLine`), so two same-named entities of one file (`Left.Squad`, `Right.Squad`) keep
 * their own relations: the entity graph has one node and one edge each, not one shared pair.
 */
describe("entity relations of same-named nested entities", () => {
  let dir = "";
  let summary: Record<string, any>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-entity-line-"));
    const root = join(dir, "repo");
    const files: Record<string, string> = {
      "Match.java": [
        "package com.example.league;", "import jakarta.persistence.*;", "import java.util.List;", "",
        "public class Match {", "  @Entity", "  public static class Left {", "    @Entity", "    public static class Squad {",
        "      @Id Long id;", "      @OneToMany List<Player> players;", "    }", "  }",
        "  @Entity", "  public static class Right {", "    @Entity", "    public static class Squad {",
        "      @Id Long id;", "      @ManyToOne Club club;", "    }", "  }", "}", "",
      ].join("\n"),
      "Club.java": ["import jakarta.persistence.*;", "@Entity", "public class Club {", "  @Id Long id;", "}", ""].join("\n"),
      "Player.java": ["import jakarta.persistence.*;", "@Entity", "public class Player {", "  @Id Long id;", "}", ""].join("\n"),
      "Match.cs": [
        "using Microsoft.EntityFrameworkCore;", "using System.Collections.Generic;", "namespace Example.League {",
        "public class Club { public int Id {get;set;} }", "public class Player { public int Id {get;set;} }",
        "public class Left {", "  public class Squad {", "    public int Id {get;set;}", "    public List<Player> Players {get;set;}", "  }", "}",
        "public class Right {", "  public class Squad {", "    public int Id {get;set;}", "    public int ClubId {get;set;}", "    public Club Club {get;set;}", "  }", "}",
        "public class LeagueContext : DbContext {", "  public DbSet<Left.Squad> LeftSquads {get;set;}", "  public DbSet<Right.Squad> RightSquads {get;set;}",
        "  public DbSet<Club> Clubs {get;set;}", "  public DbSet<Player> Players {get;set;}", "}", "}", "",
      ].join("\n"),
      "models.ts": [
        'import { Entity, PrimaryGeneratedColumn, ManyToOne } from "typeorm";',
        "@Entity() export class Club { @PrimaryGeneratedColumn() id: number; }",
        "@Entity() export class Player { @PrimaryGeneratedColumn() id: number; }",
        "export namespace Left {", "  @Entity() export class Squad {", "    @PrimaryGeneratedColumn() id: number;", "    @ManyToOne(() => Player) player: Player;", "  }", "}",
        "export namespace Right {", "  @Entity() export class Squad {", "    @PrimaryGeneratedColumn() id: number;", "    @ManyToOne(() => Club) club: Club;", "  }", "}", "",
      ].join("\n"),
      "models.rb": [
        "class Club < ApplicationRecord", "end", "class Player < ApplicationRecord", "end",
        "module Left", "  class Squad < ApplicationRecord", "    belongs_to :player", "  end", "end",
        "module Right", "  class Squad < ApplicationRecord", "    belongs_to :club", "  end", "end", "",
      ].join("\n"),
      "models.py": [
        "from sqlalchemy import Column, Integer, ForeignKey", "from sqlalchemy.orm import relationship, declarative_base", "Base = declarative_base()",
        "class Club(Base):", "    __tablename__ = 'clubs'", "    id = Column(Integer, primary_key=True)",
        "class Player(Base):", "    __tablename__ = 'players'", "    id = Column(Integer, primary_key=True)",
        "class Left:", "    class Squad(Base):", "        __tablename__ = 'left_squads'", "        id = Column(Integer, primary_key=True)",
        "        player = relationship('Player')", "        def kick(self):", "            return 1",
        "class Right:", "    class Squad(Base):", "        __tablename__ = 'right_squads'", "        id = Column(Integer, primary_key=True)",
        "        club = relationship('Club')", "        def kick(self):", "            return 2", "",
      ].join("\n"),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = (await loadReportSummary(join(dir, "out"))) as Record<string, any>;
  }, 60_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  /** The edges whose ends are in `file` or the club/player files, as unordered `a--b` pairs of the names after the file. */
  const pairs = (): Set<string> =>
    new Set(((summary.entityGraph?.edges ?? []) as Array<{ source: string; target: string }>)
      .map((e) => [e.source, e.target].map((id) => id.replace(/^[^:]+::/, "")).sort().join("--")));

  it.each([
    ["Match.java", "Match.Left.Squad", "Match.Right.Squad"],
    ["Match.cs", "Left.Squad", "Right.Squad"],
    ["models.ts", "Left.Squad", "Right.Squad"],
    ["models.rb", "Left.Squad", "Right.Squad"],
    ["models.py", "Left.Squad", "Right.Squad"],
  ])("%s: each namesake keeps its own relation", (file, left, right) => {
    const nodes = ((summary.entityGraph?.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
    expect(nodes).toContain(`${file}::${left}`);
    expect(nodes).toContain(`${file}::${right}`);
    const edge = (a: string, b: string): string => [a, b].sort().join("--");
    const all = pairs();
    expect(all.has(edge(left, "Player"))).toBe(true);
    expect(all.has(edge(right, "Club"))).toBe(true);
    // neither namesake takes the other's relation
    expect(all.has(edge(left, "Club"))).toBe(false);
    expect(all.has(edge(right, "Player"))).toBe(false);
  });
});
