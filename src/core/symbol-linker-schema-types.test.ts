/**
 * A schema's classes — an API contract's schemas and messages, a SQL table, a
 * Prisma model — are data shapes, never code a call runs or a type a call
 * constructs. A bare `update` in a Ruby model is no call into the OpenAPI
 * fragment `update.yml`, a Rust `laps(3)` no call into the `laps` table.
 * Through the real per-file pipeline, then the linker (real-repo FP).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, [Language, string]>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "schema-types-"));
  const out = await mkdtemp(join(tmpdir(), "schema-types-out-"));
  for (const [rel, [, src]] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  const analyses: FileAnalysis[] = [];
  for (const [rel, [language]] of Object.entries(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** Every link, as `file::symbol -> file::symbol [strategy]`. */
function links(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceSymbol !== "(reference)")
    .map((l) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol} [${l.strategy}]`)
    .sort();
}

const fragment = (prop: string) => ["type: object", "properties:", `  ${prop}:`, "    type: integer", ""].join("\n");

describe("a schema's classes are never call targets", () => {
  it("Ruby: a bare call and a reader named like an OpenAPI fragment reach nothing there", async () => {
    const analyses = await analyzeAll({
      "app/models/club.rb": ["ruby", ["class Club < ApplicationRecord", "  def relegate!", "    update(division: 2)", "  end", "end", ""].join("\n")],
      "app/services/transfer_service.rb": ["ruby", [
        "class TransferService",
        "  pattr_initialize [:player!]",
        "",
        "  def perform",
        "    player.touch",
        "  end",
        "end",
        "",
      ].join("\n")],
      "swagger/definitions/request/club/update.yml": ["openapi", fragment("division")],
      "swagger/definitions/resource/player.yml": ["openapi", fragment("number")],
    });
    expect(analyses.find((a) => a.filePath.endsWith("update.yml"))?.classes.map((c) => c.name)).toEqual(["update"]);
    expect(links(analyses).filter((l) => l.includes("swagger/"))).toEqual([]);
  });

  it("Java: `new Car()` is no construction of a proto message; Rust `laps(3)` no call into a SQL table", async () => {
    const analyses = await analyzeAll({
      "src/main/java/com/example/league/CarService.java": ["java", [
        "package com.example.league;",
        "",
        "public class CarService {",
        "    public Object build() {",
        "        return new Car();",
        "    }",
        "}",
        "",
      ].join("\n")],
      "proto/cars.proto": ["protobuf", ['syntax = "proto3";', "package cars.v1;", "message Car {", "  string name = 1;", "}", ""].join("\n")],
      "src/main.rs": ["rust", ["fn main() {", "    let n = laps(3);", '    println!("{}", n);', "}", ""].join("\n")],
      "db/schema.sql": ["sql", ["CREATE TABLE laps (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")],
    });
    expect(analyses.find((a) => a.filePath === "proto/cars.proto")?.classes.map((c) => c.name)).toEqual(["Car"]);
    expect(analyses.find((a) => a.filePath === "db/schema.sql")?.classes.map((c) => c.name)).toContain("laps");
    expect(links(analyses).filter((l) => /cars\.proto|schema\.sql/.test(l))).toEqual([]);
  });

  it("Ruby: `Referee.new` reaches the code class, never the Prisma model of that name", async () => {
    const prisma = ["model Referee {", "  id   Int    @id", "  name String", "}", ""].join("\n");
    const caller = ["class WhistleService", "  def call", "    Referee.new", "  end", "end", ""].join("\n");
    const modelOnly = await analyzeAll({
      "app/services/whistle_service.rb": ["ruby", caller],
      "prisma/schema.prisma": ["prisma", prisma],
    });
    expect(links(modelOnly)).toEqual([]);
    const withClass = await analyzeAll({
      "app/services/whistle_service.rb": ["ruby", caller],
      "app/models/referee.rb": ["ruby", ["class Referee", "  def initialize", "  end", "end", ""].join("\n")],
      "prisma/schema.prisma": ["prisma", prisma],
    });
    expect(links(withClass)).toEqual([
      "app/services/whistle_service.rb::WhistleService.call -> app/models/referee.rb::Referee.initialize [constructor]",
    ]);
  });
});
