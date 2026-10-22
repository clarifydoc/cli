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
});
