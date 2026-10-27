import { describe, expect, it } from "vitest";
import { createEmptyAnalysis, type FileAnalysis, type ImportInfo, type Language } from "../types/analysis.js";
import { buildImportIndex } from "./import-index.js";
import { buildModuleValueLookup, resolveTargetRefs } from "./module-values.js";
import { buildClassIndex } from "./class-index.js";
import "../extractors/registry.js";

function file(filePath: string, language: Language, values: Record<string, string> | null, imports: Array<Partial<ImportInfo> & { source: string; specifiers: string[] }> = []): FileAnalysis {
  return {
    ...createEmptyAnalysis(filePath, language),
    ...(values ? { moduleValues: values } : {}),
    imports: imports.map((i) => ({ isDefault: false, isNamespace: false, isType: false, line: 1, ...i })),
  };
}

function lookup(analyses: FileAnalysis[]) {
  return buildModuleValueLookup(analyses, buildImportIndex(analyses));
}

describe("module values across files", () => {
  it("follows a named, an aliased and a namespace import into the module that exports the value", () => {
    const links = file("src/shared/links.ts", "typescript", { CLUBS_URL: "/api/v2/clubs", environment: "x", "environment.apiUrl": "http://localhost:5000/api/" });
    const api = file("src/api/clubs.ts", "typescript", null, [
      { source: "../shared/links", specifiers: ["CLUBS_URL", "SQUAD", "environment"], aliases: { SQUAD: "CLUBS_URL" } },
      { source: "../shared/links", specifiers: ["links"], isNamespace: true },
    ]);
    const get = lookup([links, api]);
    expect(get("src/api/clubs.ts", "CLUBS_URL")).toBe("/api/v2/clubs");
    expect(get("src/api/clubs.ts", "SQUAD")).toBe("/api/v2/clubs");
    expect(get("src/api/clubs.ts", "links.CLUBS_URL")).toBe("/api/v2/clubs");
    expect(get("src/api/clubs.ts", "environment.apiUrl")).toBe("http://localhost:5000/api/");
    expect(get("src/api/clubs.ts", "PLAYERS_URL")).toBeNull();
  });

  it("reads a module a named import binds by its own name (`from tests.utils import api_routes`)", () => {
    const routes = file("tests/utils/api_routes/__init__.py", "python", { prefix: "/api", clubs_create_url: "/api/clubs/create" });
    const test = file("tests/integration/test_clubs.py", "python", null, [{ source: "tests.utils", specifiers: ["api_routes"] }]);
    const get = lookup([routes, test]);
    expect(get("tests/integration/test_clubs.py", "api_routes.clubs_create_url")).toBe("/api/clubs/create");
    expect(get("tests/integration/test_clubs.py", "api_routes.players_url")).toBeNull();
  });

  it("reads a type's member value from the file of its package that states it (a Go type spanning files)", () => {
    const cls = (name: string) => ({ name, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: false, line: 1, endLine: 3 });
    const main = { ...file("cmd/league/main.go", "go", { "leagueServer.scoutAddr": '${os.Getenv("SCOUT_ADDR")}' }), classes: [cls("leagueServer")] } as FileAnalysis;
    const handlers = { ...file("cmd/league/handlers.go", "go", null), classes: [cls("leagueServer")] } as FileAnalysis;
    const analyses = [main, handlers];
    const idx = buildImportIndex(analyses);
    const get = buildModuleValueLookup(analyses, idx, buildClassIndex(analyses, idx));
    expect(get("cmd/league/handlers.go", "leagueServer.scoutAddr")).toBe('${os.Getenv("SCOUT_ADDR")}');
  });

  it("reads a Go package by the directory its import path ends with, and resolves the value's own holes there", () => {
    const consts = file("internal/config/const.go", "go", { ApiUri: "/api/v1", DownloadUri: "${ApiUri}/dl" });
    const server = file("internal/server/routes.go", "go", null, [{ source: "github.com/example/league/internal/config", specifiers: ["config"] }]);
    const get = lookup([consts, server]);
    expect(get("internal/server/routes.go", "config.ApiUri")).toBe("/api/v1");
    expect(get("internal/server/routes.go", "config.DownloadUri")).toBe("/api/v1/dl");
    expect(get("internal/server/routes.go", "config.Missing")).toBeNull();
  });

  it("reads a bare name in the other files of the caller's own package, never a test file's", () => {
    const topics = file("league/topics.go", "go", { matchTopic: "matches" });
    const fixture = file("league/topics_test.go", "go", { garageTopic: "garage" });
    const publisher = file("league/publisher.go", "go", null);
    const get = lookup([topics, fixture, publisher]);
    expect(get("league/publisher.go", "matchTopic")).toBe("matches");
    expect(get("league/publisher.go", "garageTopic")).toBeNull();
  });

  it("refuses a name two files of a package define differently", () => {
    const a = file("league/topic_linux.go", "go", { matchTopic: "matches" });
    const b = file("league/topic_windows.go", "go", { matchTopic: "fixtures" });
    const caller = file("cmd/main.go", "go", null, [{ source: "github.com/example/league", specifiers: ["league"] }]);
    expect(lookup([a, b, caller])("cmd/main.go", "league.matchTopic")).toBeNull();
  });

  it("never reads a package directory for a language whose imports name files", () => {
    const consts = file("config/index.py", "python", { API: "/api" });
    const caller = file("app/main.py", "python", null, [{ source: "requests", specifiers: ["config"] }]);
    expect(lookup([consts, caller])("app/main.py", "config.API")).toBeNull();
  });

  it("sets a data source's target from the value its targetRef names", () => {
    const kafka = file("kafka/producer.go", "go", { Topic: "matches" });
    const checkout = file("checkout/main.go", "go", null, [{ source: "github.com/example/league/kafka", specifiers: ["kafka"] }]);
    checkout.dataSources = [
      { kind: "queue-publish", name: "MQ: sarama ProducerMessage", target: "kafka.Topic", targetRef: "kafka.Topic", calls: [], line: 9 },
      { kind: "queue-publish", name: "MQ: Publish", target: null, targetRef: "kafka.Unknown", calls: [], line: 12 },
    ];
    const analyses = [kafka, checkout];
    expect(resolveTargetRefs(analyses, lookup(analyses))).toBe(1);
    expect(checkout.dataSources.map((d) => d.target)).toEqual(["matches", null]);
  });
});
