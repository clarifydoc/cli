import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import { JavaKotlinEntityExtractor } from "./entities.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const javaFile = (filePath: string, extra: Partial<FileAnalysis>) =>
  ({ filePath, language: "java", imports: [], functions: [], classes: [], dataSources: [], ...extra }) as unknown as FileAnalysis;

describe("Spring Data repositories state their entity", () => {
  it("keeps an interface's super-interface type arguments", async () => {
    const src = `package com.example.league;
public interface RepositoryFan extends JpaRepository<EntityClubFan, Long> {
  boolean existsByEmail(String email);
}`;
    const tree = await parseSource(src, "java" as never, "RepositoryFan.java");
    const classes = new JavaKotlinExtractor().extractClasses(tree, src);
    expect(classes[0]).toMatchObject({ name: "RepositoryFan", kind: "interface", extends: "JpaRepository<EntityClubFan, Long>" });
  });

  it("renames a DAO row's implied entity to the one its repository states", () => {
    const entity = javaFile("src/main/java/league/EntityClubFan.java", {
      classes: [{ name: "EntityClubFan", kind: "class", extends: null, implements: [], decorators: ["Entity", "entity", "jpa"], methods: [], properties: [], isExported: true, line: 1, endLine: 5 }],
    });
    const repo = javaFile("src/main/java/league/RepositoryFan.java", {
      classes: [{ name: "RepositoryFan", kind: "interface", extends: "JpaRepository<EntityClubFan, Long>", implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 3 }],
    });
    const config = javaFile("src/main/java/league/RepositoryKitConfiguration.java", {
      classes: [{ name: "RepositoryKitConfiguration", kind: "interface", extends: "JpaRepository<EntityKitConfiguration, Integer>", implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 3 }],
    });
    const kitEntity = javaFile("src/main/java/league/EntityKitConfiguration.java", {
      classes: [{ name: "EntityKitConfiguration", kind: "class", extends: null, implements: [], decorators: ["Entity", "entity", "jpa"], methods: [], properties: [], isExported: true, line: 1, endLine: 5 }],
    });
    const field = (name: string, type: string) => ({ name, type, visibility: "private" as const, isStatic: false, isReadonly: true });
    const service = javaFile("src/main/java/league/FanService.java", {
      classes: [{ name: "FanService", kind: "class", extends: null, implements: [], decorators: ["Service"], methods: [], isExported: true, line: 1, endLine: 30,
        properties: [field("repositoryFan", "RepositoryFan"), field("kitRepository", "RepositoryKitConfiguration")] }],
      dataSources: [
        { kind: "database", name: "DAO: findByClub", target: "kit", entity: "kit", access: "read", calls: [], line: 10 },
        { kind: "database", name: "DAO: existsByEmail", target: "Fan", entity: "Fan", access: "read", calls: [], line: 12 },
        { kind: "database", name: "DAO: save", target: "Kit", entity: "Kit", access: "write", calls: [], line: 14 },
      ],
    });
    new JavaKotlinEntityExtractor().reconcileProject([entity, repo, config, kitEntity, service]);
    expect(service.dataSources.map((d) => `${d.target} ${d.entity}`)).toEqual([
      "EntityKitConfiguration EntityKitConfiguration",
      "EntityClubFan EntityClubFan",
      "Kit Kit",
    ]);
  });

  it("takes the type argument when the entity comes from a dependency", () => {
    const repo = javaFile("src/main/java/league/MatchRepository.java", {
      classes: [{ name: "MatchRepository", kind: "interface", extends: "Repository<MatchSheetEntity, String>", implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 3 }],
    });
    const generic = javaFile("src/main/java/league/BaseRepository.java", {
      classes: [{ name: "BaseRepository", kind: "interface", extends: "JpaRepository<T, Long>", implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 3 }],
    });
    const field = (name: string, type: string) => ({ name, type, visibility: "private" as const, isStatic: false, isReadonly: true });
    const service = javaFile("src/main/java/league/MatchService.java", {
      classes: [{ name: "MatchService", kind: "class", extends: null, implements: [], decorators: ["Service"], methods: [], isExported: true, line: 1, endLine: 30,
        properties: [field("matchRepository", "MatchRepository"), field("baseRepository", "BaseRepository")] }],
      dataSources: [
        { kind: "database", name: "DAO: findByIdAndClubId", target: "Match", entity: "Match", access: "read", calls: [], line: 10 },
        { kind: "database", name: "DAO: findAll", target: "Base", entity: "Base", access: "read", calls: [], line: 12 },
      ],
    });
    new JavaKotlinEntityExtractor().reconcileProject([repo, generic, service]);
    expect(service.dataSources.map((d) => `${d.target} ${d.entity}`)).toEqual(["MatchSheetEntity MatchSheetEntity", "Base Base"]);
  });

  it("types a generic DAO method's write by the variable each caller hands it", () => {
    const dao = javaFile("src/main/java/league/dao/LeagueChange.java", {
      classes: [{ name: "LeagueChange", kind: "class", extends: null, implements: [], decorators: [], properties: [], isExported: true, line: 1, endLine: 40,
        methods: [{ name: "create", params: [{ name: "entity", type: "T", defaultValue: null }], calls: [], line: 10, endLine: 16, returnType: "T", isAsync: false, isExported: true, decorators: [] }] }],
      dataSources: [{ kind: "database", name: "merge", target: null, access: "write", calls: [], line: 12 }],
    });
    const field = (name: string, type: string) => ({ name, type, visibility: "private" as const, isStatic: false, isReadonly: true });
    const service = javaFile("src/main/java/league/ClubService.java", {
      classes: [{ name: "ClubService", kind: "class", extends: null, implements: [], decorators: ["Service"], isExported: true, line: 1, endLine: 30,
        properties: [field("change", "LeagueChange"), field("cache", "ClubCache")],
        methods: [{ name: "register", params: [{ name: "club", type: "Club", defaultValue: null }, { name: "id", type: "String", defaultValue: null }], line: 5, endLine: 12, returnType: null, isAsync: false, isExported: true, decorators: [],
          calls: [
            { name: "change.create", kind: "cross-file", target: null, line: 7, args: ["club"] },
            { name: "change.create", kind: "cross-file", target: null, line: 8, args: ["id"] },
            { name: "cache.create", kind: "cross-file", target: null, line: 9, args: ["club"] },
          ] }] }],
    });
    new JavaKotlinEntityExtractor().reconcileProject([dao, service]);
    expect(service.dataSources.map((d) => `${d.line} ${d.name} ${d.entity} ${d.access}`)).toEqual(["7 LeagueChange.create Club write"]);
  });
});

describe("a DAO whose implementation's SQL names its table", () => {
  it("types a call through the DAO by that table, not the value class its name spells", () => {
    const field = (name: string, type: string) => ({ name, type, visibility: "private" as const, isStatic: false, isReadonly: true });
    const impl = javaFile("src/main/java/league/MatchEventDAOImpl.java", {
      classes: [{ name: "MatchEventDAOImpl", kind: "class", extends: null, implements: ["MatchEventDAO"], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 40 }],
      dataSources: [
        { kind: "database", name: "INSERT INTO", target: "league_event_queue", entity: "league_event_queue", access: "write", calls: [], line: 10 },
        { kind: "database", name: "DELETE FROM", target: "league_event_queue", entity: "league_event_queue", access: "write", calls: [], line: 20 },
      ],
    });
    // Two tables: which one a call means is not stated.
    const mixed = javaFile("src/main/java/league/KitDAOImpl.java", {
      classes: [{ name: "KitDAOImpl", kind: "class", extends: null, implements: ["KitDAO"], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 40 }],
      dataSources: [
        { kind: "database", name: "SELECT", target: "kits", entity: "kits", access: "read", calls: [], line: 10 },
        { kind: "database", name: "SELECT", target: "kit_sizes", entity: "kit_sizes", access: "read", calls: [], line: 20 },
      ],
    });
    const publisher = javaFile("src/main/java/league/MatchPublisher.java", {
      classes: [{ name: "MatchPublisher", kind: "class", extends: null, implements: [], decorators: [], methods: [], isExported: true, line: 1, endLine: 30,
        properties: [field("matchEventDAO", "MatchEventDAO"), field("kitDAO", "KitDAO")] }],
      dataSources: [
        { kind: "database", name: "DAO: create", target: "MatchEvent", entity: "MatchEvent", access: "write", calls: [], line: 10 },
        { kind: "database", name: "DAO: find", target: "Kit", entity: "Kit", access: "read", calls: [], line: 12 },
      ],
    });
    new JavaKotlinEntityExtractor().reconcileProject([impl, mixed, publisher]);
    expect(publisher.dataSources.map((d) => `${d.target} ${d.entity}`)).toEqual(["league_event_queue league_event_queue", "Kit Kit"]);
  });
});
