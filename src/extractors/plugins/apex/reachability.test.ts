import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { childRelationships } from "./soql.js";

describe("child relationships a subquery names", () => {
  it("reads those before the query's own FROM, with the parent object", () => {
    expect(childRelationships("[SELECT Id, (SELECT Id FROM Players__r WHERE Shirt__c > 1), (SELECT Id FROM Fans__r) FROM Club__c]")).toEqual([
      { parent: "Club__c", name: "Players__r" },
      { parent: "Club__c", name: "Fans__r" },
    ]);
  });
  it("leaves a semi-join, a string and SOSL alone", () => {
    expect(childRelationships("[SELECT Id FROM Club__c WHERE Id IN (SELECT Club__c FROM Player__c)]")).toEqual([]);
    expect(childRelationships("[SELECT Id FROM Club__c WHERE Name = '(SELECT Id FROM Players__r)']")).toEqual([]);
    expect(childRelationships("[FIND 'x' RETURNING Club__c(Id, (SELECT Id FROM Players__r))]")).toEqual([]);
  });
});

describe("sample-salesforce — reachability and relationship subqueries", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-salesforce-dead-"));
    await analyze({ projectRoot: resolve(__dirname, "..", "..", "..", "..", "test-fixtures", "sample-salesforce"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const dir = "force-app/main/default/classes/";

  it("reports only the classes nothing names, calls or the platform runs", () => {
    // Written by hand from the fixture: LeagueCallout, PlayerService and StaleTicketing are named by no file;
    // SquadNotifier is spelled `squadnotifier` (Apex ignores case), SquadSync only by a flow, Handler_* by a built
    // `Type.forName('Handler_' + side)`, StadiumSchedule is Schedulable, ClubReports an @InvocableMethod.
    expect(summary.deadCode!.files.map((f) => f.filePath).sort()).toEqual([`${dir}LeagueCallout.cls`, `${dir}PlayerService.cls`, `${dir}StaleTicketing.cls`]);
  });

  it("names why each entry starts a program", () => {
    const why = new Map((summary.deadCode!.entries ?? []).map((e) => [e.filePath, e.reason]));
    expect(why.get("force-app/main/default/triggers/ClubTrigger.trigger")).toMatch(/trigger/);
    expect(why.get(`${dir}ClubResource.cls`)).toMatch(/RestResource/);
    expect(why.get(`${dir}StadiumSchedule.cls`)).toMatch(/Schedulable/);
    expect(why.get(`${dir}SquadSync.cls`)).toMatch(/named in configuration/);
    expect(why.get(`${dir}ClubServiceTest.cls`)).toBeUndefined();
    // `unpackaged/` is no packageDirectories path of sfdx-project.json: passive, never reported.
    expect(why.get("unpackaged/classes/OffsiteBooking.cls")).toBeUndefined();
  });

  it("reads the child a relationship subquery names, never one no field declares", () => {
    const calls = summary.dataAccessGraph!.edges
      .filter((e) => e.source === `file::${dir}ClubReports.cls`)
      .map((e) => `${e.target} ${(e.calls ?? []).map((c) => c.line).join(",")}`)
      .sort();
    // Players__r (a Lookup's relationshipName Players) reads Player__c; Fans__r is declared by no field. Line 4 is the
    // `standings` property's getter.
    expect(calls).toEqual(["entity::Club__c::Club__c 4,10,25", "entity::Player__c::Player__c 10,25"]);
    expect(summary.dataAccessGraph!.nodes.some((n) => /Fans/i.test(n.id))).toBe(false);
  });
});
