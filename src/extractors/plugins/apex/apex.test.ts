import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";
import { elementType, isSObjectType, queryObjects } from "./soql.js";
import { restPath } from "./routes.js";
import { apexClassSource } from "./preprocess.js";

/** One file through the plugin as the analyzer runs it (`.cls` goes through the VB plugin's hand-over). */
function read(src: string, path = "classes/ClubService.cls"): FileAnalysis {
  const plugin = pluginFor(path.endsWith(".trigger") ? "apex" : "vb")!;
  const pre = plugin.preprocess!(src, path);
  if (!pre || "skip" in pre) throw new Error("not read");
  const analysis = extractWithRegex(pre.sourceText, path, pre.language);
  pre.postExtract?.(analysis, src);
  return analysis;
}
const rows = (a: FileAnalysis) => a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.name} ${d.entity} ${d.access ?? "-"} @${d.line}`);

describe("SOQL, DML and type reading", () => {
  it("reads the object a query names, never a relationship subquery", () => {
    expect(queryObjects("[SELECT Id, (SELECT Id FROM Players__r) FROM Club__c WHERE Name = 'FROM Other__c']")).toEqual(["Club__c"]);
    expect(queryObjects("SELECT COUNT() FROM Player__c")).toEqual(["Player__c"]);
    expect(queryObjects("[SELECT Id FROM Club__c WHERE Id IN (SELECT Club__c FROM Player__c)]")).toEqual(["Club__c", "Player__c"]);
    expect(queryObjects("[FIND 'Rovers' IN ALL FIELDS RETURNING Club__c(Id, Name), Player__c]")).toEqual(["Club__c", "Player__c"]);
  });

  it("takes the SObject out of a declared type", () => {
    expect(elementType("List<Club__c>")).toBe("Club__c");
    expect(elementType("Club__c[]")).toBe("Club__c");
    expect(elementType("Map<Id, Club__c>")).toBe("Club__c");
    expect(elementType("Schema.Account")).toBe("Account");
    expect(isSObjectType("Club__c") && isSObjectType("account") && isSObjectType("Club__mdt")).toBe(true);
    expect(isSObjectType("ClubDto") || isSObjectType("Id") || isSObjectType("String")).toBe(false);
  });

  it("writes the type the operand declares, in every DML form", () => {
    const a = read([
      "public class ClubService {",
      "    private List<Player__c> squad;",
      "    public void run(Club__c club, Map<Id, Club__c> byId, Set<Id> ids, ClubDto dto) {",
      "        insert club;",
      "        update byId.values();",
      "        upsert squad Player__c.Fields.Ext__c;",
      "        delete new Club__c(Id = ids);",
      "        Database.insert(squad, false);",
      "        Database.delete(new List<Id>(ids));",
      "        insert dto;",
      "        if (club != null) undelete club;",
      "        merge club club;",
      "        insert as user club;",
      "        insert makeClub();",
      "    }",
      "}",
    ].join("\n"));
    expect(rows(a)).toEqual([
      "INSERT Club__c write @4",
      "UPDATE Club__c write @5",
      "UPSERT Player__c write @6",
      "DELETE Club__c write @7",
      "Database.insert Player__c write @8",
      "UNDELETE Club__c write @11",
      "MERGE Club__c write @12",
      "INSERT Club__c write @13",
    ]);
  });

  it("reads queries held in strings, joined across `+`, and ignores comments and prose", () => {
    const a = read([
      "public class Q {",
      "    // [SELECT Id FROM Ghost__c]",
      "    /* Database.query('SELECT Id FROM Ghost2__c') */",
      "    public void run(String extra, String objectName) {",
      "        String a = 'SELECT Id ' + 'FROM Club__c WHERE Name = \\'' + extra + '\\'';",
      "        String b = 'SELECT Id FROM ' + objectName;",
      "        String c = 'Please select a club from the list';",
      "        List<SObject> rows = Database.query(a);",
      "    }",
      "}",
    ].join("\n"));
    expect(rows(a)).toEqual(["SELECT Club__c read @5"]);
  });

  it("states a callout's verb from the same variable and keeps a Named Credential as an external base", () => {
    const a = read([
      "public class C {",
      "    public void run(String id) {",
      "        HttpRequest one = new HttpRequest();",
      "        HttpRequest two = new HttpRequest();",
      "        one.setEndpoint('callout:League/clubs/' + id);",
      "        two.setEndpoint('https://api.example.com/x');",
      "        two.setMethod('DELETE');",
      "        one.setMethod('GET');",
      "    }",
      "}",
    ].join("\n"));
    const calls = a.dataSources.filter((d) => d.kind === "api-call");
    expect(calls.map((c) => [c.name, c.baseRef?.key])).toEqual([["GET /clubs/{id}", "callout:League"], ["DELETE https://api.example.com/x", undefined]]);
  });

  it("does not take a credential named by a variable for a Named Credential", () => {
    const a = read("public class C {\n  public void run(String cred, String path) {\n    HttpRequest r = new HttpRequest();\n    r.setEndpoint('callout:' + cred + path);\n    r.setMethod('GET');\n  }\n}\n");
    expect(a.dataSources.map((d) => [d.target, d.baseRef])).toEqual([["callout:{cred}{path}", undefined]]);
  });

  it("joins the pieces of a query across a variable", () => {
    const a = read("public class C {\n  public void run(String fields) {\n    String q = 'SELECT ' + fields + ' FROM Club__c WHERE Id != null';\n    Database.query(q);\n  }\n}\n");
    expect(rows(a)).toEqual(["SELECT Club__c read @3"]);
  });
});

describe("Apex structure", () => {
  it("reads classes, inner classes, annotations with arguments and the owner of each method", () => {
    const a = read([
      "@RestResource(urlMapping='/clubs/*')",
      "global with sharing class ClubApi extends Base implements Database.Batchable<SObject>, Schedulable {",
      "    @TestVisible private static final String NAME = 'x{y';",
      "    public Integer count { get; set; }",
      "    @HttpGet global static Club__c get() { return null; }",
      "    @AuraEnabled(cacheable=true)",
      "    public static List<Club__c> all() { return new List<Club__c>(); }",
      "    public class Wrapper {",
      "        public String label;",
      "        public Wrapper(String label) { this.label = label; }",
      "        public String show() { return label; }",
      "    }",
      "    void helper() { }",
      "}",
    ].join("\n"));
    const [outer, inner] = a.classes;
    expect(outer).toMatchObject({ name: "ClubApi", extends: "Base", implements: ["Database.Batchable", "Schedulable"], decorators: ["RestResource(urlMapping='/clubs/*')"] });
    expect(outer!.methods.map((m) => [m.name, m.decorators])).toEqual([
      ["get", ["HttpGet"]], ["all", ["AuraEnabled(cacheable=true)"]], ["helper", []],
    ]);
    expect(outer!.properties.map((p) => p.name)).toEqual(["NAME", "count"]);
    expect(inner!.name).toBe("Wrapper");
    expect(inner!.methods.map((m) => m.name)).toEqual(["Wrapper", "show"]);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual(["GET /services/apexrest/clubs/{wildcard} ClubApi.get"]);
  });

  it("reads a trigger as a function on its object", () => {
    const a = read("trigger ClubTrigger on Club__c (before insert, after update) {\n    ClubService.promote(Trigger.new[0]);\n}\n", "triggers/ClubTrigger.trigger");
    expect(a.functions.map((f) => [f.name, f.decorators])).toEqual([["ClubTrigger", ["Trigger(Club__c; before insert, after update)"]]]);
    expect(rows(a)).toEqual(["TRIGGER before insert, after update Club__c - @1"]);
  });

  it("spells a urlMapping's wildcard segments as placeholders", () => {
    expect(restPath("/clubs/*")).toBe("/services/apexrest/clubs/{wildcard}");
    expect(restPath("/clubs/*/players")).toBe("/services/apexrest/clubs/{wildcard}/players");
    expect(restPath("clubs")).toBe("/services/apexrest/clubs");
    expect(restPath("/club*")).toBe("/services/apexrest/club*");
  });

  it("takes only an Apex class from VB6's `.cls`", () => {
    expect(apexClassSource("public class A {\n}\n")).not.toBeNull();
    expect(apexClassSource("VERSION 1.0 CLASS\nBEGIN\nEND\nAttribute VB_Name = \"A\"\nPublic Sub Run()\nEnd Sub\n")).toBeNull();
    expect(apexClassSource("Public Class A\nEnd Class\n")).toBeNull();
    expect(apexClassSource("/*\nEnd Class of changes\n*/\npublic class A {\n}\n")).not.toBeNull();
  });
});

describe("sample-salesforce — Apex to SObject", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-salesforce-"));
    await analyze({ projectRoot: resolve(__dirname, "..", "..", "..", "..", "test-fixtures", "sample-salesforce"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const links = () => summary.symbolLinks!.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`);

  it("serves the REST resource under the platform base, one route per verb", () => {
    expect(summary.routeMap!.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual([
      "DELETE /services/apexrest/clubs/{wildcard} ClubResource.deleteClub",
      "GET /services/apexrest/clubs/{wildcard} ClubResource.getClub",
      "POST /services/apexrest/clubs/{wildcard} ClubResource.createClub",
    ]);
  });

  it("links static, constructed, field-typed and local-typed calls inside the project", () => {
    const l = links();
    for (const want of [
      "ClubController.promoteClub -> ClubService.promote",
      "ClubController.promoteClub -> ClubService.recalculate",
      "ClubController.rename -> ClubService.promote",
      "ClubTrigger -> ClubService.promote",
      "ClubService.recalculate -> ClubService.save",
      "PlayerService.transfer -> PlayerService.save",
    ]) expect(l).toContain(want);
  });

  it("never reaches the namesake save() of the other class, nor a platform call", () => {
    const l = links();
    expect(l.filter((x) => x.endsWith("-> PlayerService.save")).every((x) => x.startsWith("PlayerService."))).toBe(true);
    expect(l.filter((x) => x.endsWith("-> ClubService.save")).every((x) => x.startsWith("ClubService."))).toBe(true);
    expect(l.some((x) => /Database|System|Http/.test(x.split(" -> ")[1]!))).toBe(false);
  });

  it("reads and writes the SObject each statement names", () => {
    const entityRows = (file: string) => {
      const edge = summary.dataAccessGraph!.edges.filter((e) => e.source === `file::force-app/main/default/classes/${file}`);
      return edge.flatMap((e) => (e.calls ?? []).map((c) => `${c.name} ${c.entity}`)).sort();
    };
    expect(entityRows("ClubController.cls")).toEqual(["SELECT Club__c", "SELECT Club__c", "SELECT Club__c", "SELECT Player__c", "UPDATE Club__c"]);
    expect(entityRows("PlayerService.cls")).toEqual(["UPDATE Player__c"]);
    expect(entityRows("ClubResource.cls")).toEqual(["DELETE Club__c", "INSERT Club__c", "SELECT Club__c"]);
  });

  it("states the callouts with a Named Credential as an external base", () => {
    expect(summary.apiCalls!.map((c) => c.name).sort()).toEqual(["GET /table/{season}", "POST https://api.example.com/v2/results"]);
  });

  it("builds SObject entities from the metadata, with columns from field files and the lookup as a relation", () => {
    const nodes = summary.entityGraph!.nodes;
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n.columns.map((c) => c.name).sort()]));
    expect(byName).toEqual({
      Club__c: ["Id", "Rating__c", "Stadium__c"],
      Player__c: ["Club__c", "Id", "Shirt__c"],
      // A standard object is an entity because the project adds a field to it.
      Account: ["Id", "League__c"],
    });
    const edges = summary.entityGraph!.edges;
    expect(edges).toHaveLength(1);
    expect([edges[0]!.source, edges[0]!.target].map((id) => String(id).split("::").pop())).toEqual(["Club__c", "Player__c"]);
    expect(edges[0]).toMatchObject({ sourceCardinality: "one", targetCardinality: "many", fields: ["Club__c"], orm: "salesforce", confidence: "EXTRACTED" });
  });
});
