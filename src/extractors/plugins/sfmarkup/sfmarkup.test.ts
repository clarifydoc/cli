import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { loadAllPlugins, preprocessFile } from "../../registry.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { auraScriptPreprocess } from "../javascript/aura-controllers.js";
import { expressionHeads } from "./index.js";

describe("Aura and Visualforce readers", () => {
  beforeAll(loadAllPlugins);

  it("refuses a `.cmp`, `.page` or `.component` that is neither Aura nor Visualforce markup", async () => {
    for (const path of ["ui/Button.cmp", "docs/Intro.page", "web/card.component"]) {
      const pre = await preprocessFile("sfmarkup", "<div class=\"card\"><button onclick=\"{!save}\">Save</button></div>", path);
      expect(pre && "skip" in pre).toBe(true);
    }
    const ok = await preprocessFile("sfmarkup", "<apex:page controller=\"ClubController\"></apex:page>", "pages/A.page");
    expect(ok && "skip" in ok).toBe(false);
  });

  it("reads a Visualforce page's controller, extensions, actions and the members its expressions read", async () => {
    const src = [
      "<apex:page controller=\"ClubController\" extensions=\"a.ClubExtension, ClubTable\" action=\"{!init}\">",
      "  <!-- <apex:commandButton action=\"{!ghost}\"/> -->",
      "  <apex:pageBlockTable value=\"{!clubs}\" var=\"c\" rendered=\"{!IF(canEdit, true, false) && hasClubs}\">",
      "    <apex:column value=\"{!c.Name}\" />",
      "    <apex:column value=\"{!$User.LastName} {!tableTitle & 'x'}\" />",
      "  </apex:pageBlockTable>",
      "  <br><script>for (var i = 0; i < n; i++) { run('<apex:commandButton action=\"{!ghost2}\"/>'); }</script>",
      "  <apex:commandLink action=\"{!save}\" />",
      "</apex:page>",
    ].join("\n");
    const pre = await preprocessFile("sfmarkup", src, "pages/ClubEdit.page");
    if (!pre || "skip" in pre) throw new Error("not read");
    const a = extractWithRegex(pre.sourceText, "pages/ClubEdit.page", pre.language);
    pre.postExtract?.(a, src);
    expect(a.interactiveElements.map((e) => `${e.handler}@${e.line}`)).toEqual(["init@1", "save@8"]);
    const setup = a.functions.find((f) => f.name === "<setup>")!;
    expect(setup.decorators).toEqual(["Controller(ClubController)", "Extension(ClubExtension)", "Extension(ClubTable)"]);
    expect(setup.calls.map((c) => c.name)).toEqual(["clubs", "canEdit", "hasClubs", "tableTitle"]);
    expect(a.screens![0]).toMatchObject({ name: "ClubEdit", formType: "apex:page", viewModel: "ClubController" });
  });

  it("takes the head of a path, never a function, a literal, a global or a string's words", () => {
    expect(expressionHeads("IF(NOT(ISBLANK(club.Name)), 'x y', clubs[0].Name)")).toEqual(["club", "clubs"]);
    expect(expressionHeads("$CurrentPage.parameters.id")).toEqual([]);
  });

  it("reads only `{!c.name}` of an Aura component as a handler, wherever it is bound", async () => {
    const src = [
      "<aura:component controller=\"ClubController\">",
      "  <aura:handler name=\"init\" value=\"{!this}\" action=\"{!c.doInit}\" />",
      "  <lightning:button onclick=\"{!c.save}\" label=\"{!v.label}\" />",
      "  <c:clubCard club=\"{!v.club}\" onselect=\"{!c.pick}\" />",
      "</aura:component>",
    ].join("\n");
    const pre = await preprocessFile("sfmarkup", src, "aura/clubList/clubList.cmp");
    if (!pre || "skip" in pre) throw new Error("not read");
    const a = extractWithRegex(pre.sourceText, "aura/clubList/clubList.cmp", pre.language);
    expect(a.interactiveElements.map((e) => `${e.event}:${e.handler}`)).toEqual(["init:doInit", "click:save", "select:pick"]);
    expect(a.subComponents.map((s) => s.name)).toEqual(["clubCard"]);
  });

  it("reads an Aura script object as functions, and a server action by its literal name only", () => {
    const src = "({\n  save: function (component) {\n    var a = component.get(\"c.saveClub\");\n    var s = component.get(\"v.season\");\n    // component.get(\"c.ghost\");\n    helper.go(component);\n  }\n})\n";
    const pre = auraScriptPreprocess(src, "aura/clubList/clubListController.js");
    expect(pre?.sourceText.split("\n").length).toBe(src.split("\n").length);
    expect(pre?.sourceText).toContain("var clubListController = ");
    expect(auraScriptPreprocess(src, "src/other/clubListController.js")).toBeNull();
    // Method shorthand needs no `function` keyword.
    expect(auraScriptPreprocess("({ save(cmp) { return 1; } })", "aura/clubList/clubListController.js")).not.toBeNull();
    expect(auraScriptPreprocess("module.exports = {};", "aura/clubList/clubListController.js")).toBeNull();
  });
});

describe("sample-salesforce — Aura and Visualforce to Apex", () => {
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-sfmarkup-"));
    await analyze({ projectRoot: resolve(__dirname, "..", "..", "..", "..", "test-fixtures", "sample-salesforce"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const linksFrom = (file: string) =>
    summary.symbolLinks!
      .filter((l) => l.sourceFile.endsWith(file))
      .map((l) => `${l.sourceSymbol}:${l.sourceLine} ${l.callName} -> ${l.targetFile.split("/").pop()} ${l.targetSymbol}`)
      .sort();

  it("makes the component and the page screens that bind their Apex controller", () => {
    const named = summary.screens!.filter((s) => /\/(?:aura|pages)\//.test(s.filePath));
    expect(named.map((s) => `${s.name} ${s.formType} ${s.viewModel}`).sort()).toEqual([
      "ClubEdit apex:page ClubController",
      "clubList aura:component ClubController",
      "clubTile aura:component undefined",
      "leagueApp aura:application ClubController",
      "rivalTile aura:component undefined",
    ]);
  });

  it("joins the markup's handlers to the controller, the controller to the helper, the scripts to the AuraEnabled method", () => {
    expect(linksFrom("clubList.cmp")).toEqual([
      "<component>:11 handleRival -> clubListController.js clubListController.handleRival",
      "<component>:4 doInit -> clubListController.js clubListController.doInit",
      "<component>:5 handleSave -> clubListController.js clubListController.handleSave",
      "<component>:6 handlePromote -> clubListController.js clubListController.handlePromote",
      "<component>:9 handleSelected -> clubListController.js clubListController.handleSelected",
    ]);
    expect(linksFrom("clubListController.js")).toEqual([
      "clubListController.doInit:3 helper.load -> clubListHelper.js clubListHelper.load",
      "clubListController.handlePromote:10 c.promoteClub -> ClubController.cls ClubController.promoteClub",
      "clubListController.handleRival:18 helper.load -> clubListHelper.js clubListHelper.load",
      "clubListController.handleSave:6 helper.save -> clubListHelper.js clubListHelper.save",
      "clubListController.handleSelected:15 helper.save -> clubListHelper.js clubListHelper.save",
    ]);
    expect(linksFrom("clubListHelper.js")).toEqual([
      "clubListHelper.load:4 c.getClubs -> ClubController.cls ClubController.getClubs",
      "clubListHelper.save:11 c.promoteClub -> ClubController.cls ClubController.promoteClub",
    ]);
  });

  it("never reaches the namesake methods of a class the component does not name, nor the namesake `load` of another component", () => {
    const all = summary.symbolLinks!.filter((l) => /\/(?:aura|pages)\//.test(l.sourceFile));
    expect(all.some((l) => l.targetFile.endsWith("ClubAudit.cls"))).toBe(false);
    expect(all.some((l) => l.targetFile.includes("/lwc/"))).toBe(false);
    // `component.get("v.season")` is an attribute read, no call of anything.
    expect(all.some((l) => l.callName === "v.season")).toBe(false);
  });

  it("joins a page's actions and reads to the extension first, then the controller's getter", () => {
    expect(linksFrom("ClubEdit.page")).toEqual([
      "<component>:7 save -> ClubExtension.cls ClubExtension.save",
      "<component>:8 recalc -> ClubExtension.cls ClubExtension.recalc",
      "<setup>:4 clubs -> ClubController.cls ClubController.getClubs",
      "<setup>:9 standings -> ClubExtension.cls ClubExtension.standings",
    ]);
  });

  it("reads a property whose getter has a body as a function of its own, never a namesake class's", () => {
    const getter = summary.symbolDataAccess!.filter((r) => r.symbol.endsWith(".standings")).map((r) => `${r.symbol} ${r.entity}`).sort();
    expect(getter).toEqual(["ClubExtension.standings Player__c", "ClubReports.standings Club__c"]);
    expect(summary.symbolLinks!.filter((l) => l.targetSymbol === "ClubReports.standings")).toEqual([]);
  });

  it("joins a fired component event to the handler the rendering component binds, and an application event to every handler of it", () => {
    const fired = summary.symbolLinks!
      .filter((l) => l.callName.startsWith("fire:"))
      .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)
      .sort();
    expect(fired).toEqual([
      "clubTileController.pick fire:clubSelected -> clubListController.handleSelected",
      "clubTileController.refresh fire:e.leagueRefreshed -> leagueAppController.reload",
      "rivalTileController.pick fire:clubSelected -> clubListController.handleRival",
    ]);
  });

  it("reads an Aura application as a screen", () => {
    expect(summary.screens!.some((sc) => sc.filePath.endsWith("leagueApp/leagueApp.app"))).toBe(true);
  });

  it("carries each screen to the tables behind its Apex methods", () => {
    const reach = (file: string) =>
      summary.dataFlows!
        .filter((f) => f.entryKind === "screen" && f.entryFile.endsWith(file))
        .map((f) => `${f.effect} ${f.resource}`)
        .sort();
    expect(reach("clubList.cmp")).toEqual(["db-read Club__c", "db-read Player__c", "db-write Club__c", "db-write Player__c"]);
    expect(reach("ClubEdit.page")).toEqual(["db-read Club__c", "db-read Player__c", "db-write Club__c", "db-write Player__c"]);
    const viaAura = summary.dataFlows!.find((f) => f.entryFile.endsWith("clubList.cmp") && f.effect === "db-write" && f.resource === "Club__c")!;
    expect(viaAura.via!.map((v) => v.symbol)).toEqual(["<component>", "clubListController.handlePromote", "ClubController.promoteClub", "ClubService.promote"]);
  });
});
