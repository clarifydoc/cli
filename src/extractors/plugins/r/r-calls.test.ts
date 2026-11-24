import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("R calls the text linker needs help with (E-312)", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    DESCRIPTION: "Package: league\nVersion: 0.1\n",
    "R/promote.R": [
      "promote <- function(n) n + 1",
      '"%+%" <- function(a, b) paste0(a, b)',
      "`rank<-` <- function(x, value) x",
    ].join("\n"),
    "other/decoy.R": "promote <- function(n) n\n",
    "R/classes.R": [
      'Base <- R6::R6Class("Base", public = list(sign = function() 1))',
      'Player <- R6::R6Class("Player", inherit = Base, public = list(name = NULL))',
      'Squad <- setRefClass("Squad", methods = list(add = function() 1))',
      'setGeneric("describe", function(x) standardGeneric("describe"))',
      'setClass("Club", representation(id = "numeric"))',
      'setMethod("describe", "Club", function(x) 1)',
      'setMethod("describe", "Squad", function(x) 2)',
      'setGeneric("rename<-", function(x, value) standardGeneric("rename<-"))',
      'setReplaceMethod("rename", "Club", function(x, value) x)',
    ].join("\n"),
    "R/main.R": [
      "run <- function(xs) {",
      "  league::promote(3)",
      "  rank(xs) <- 2",
      "  names(xs) <- c('a')",
      "  xs %in% 1",
      "  1 %+% 2",
      "  3 %nowhere% 4",
      "  p <- Player$new()",
      "  p$sign()",
      "  s <- Squad$new()",
      "  s$add()",
      "  describe(1)",
      "  rename(s) <- 1",
      "}",
      "other_pkg <- function() thirdparty::promote(1)",
    ].join("\n"),
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-r-calls-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const from = (symbol: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => `${l.targetFile}:${l.targetSymbol}:${l.confidence ?? "EXTRACTED"}`);

  it("links `pkg::f()` of the package's own name into its R/ directory, never a namesake elsewhere", () => {
    expect(from("run", "promote")).toEqual(["R/promote.R:promote:EXTRACTED"]);
    expect(from("other_pkg", "thirdparty.promote")).toEqual([]);
    expect(summary.symbolLinks.some((l) => l.targetFile === "other/decoy.R")).toBe(false);
  });

  it("reads a replacement call and a project infix operator as calls, (base R infix and `names<-` are no calls; one nothing defines links nowhere)", async () => {
    expect(from("run", "rank<-")).toEqual(["R/promote.R:rank<-:INFERRED"]);
    expect(from("run", "%nowhere%")).toEqual([]);
    expect(from("run", "%+%")).toEqual(["R/promote.R:%+%:INFERRED"]);
    const main = JSON.parse(await (await import("fs/promises")).readFile(join(dir, "out", "R/main.R.json"), "utf8"));
    expect(main.functions.find((f: { name: string }) => f.name === "run").calls.map((c: { name: string }) => c.name)).toEqual([
      "league.promote", "rank<-", "%+%", "%nowhere%", "Player.new", "p.sign", "Squad.new", "s.add", "describe", "rename<-",
    ]);
  });

  it("types a local assigned `X$new()` as X, through its bases", () => {
    expect(from("run", "p.sign")).toEqual(["R/classes.R:Base.sign:INFERRED"]);
    expect(from("run", "s.add")).toEqual(["R/classes.R:Squad.add:INFERRED"]);
  });

  it("reads setReplaceMethod as the method of the replacement generic", () => {
    // the generic itself (a direct link) and the method body it fans out to
    expect(from("run", "rename<-").sort()).toEqual(["R/classes.R:Club.rename<-:INFERRED", expect.stringMatching(/^R\/classes\.R:rename<-:/)]);
  });

  it("fans a call to an S4 generic out to its setMethod bodies", () => {
    expect(from("run", "describe").sort()).toEqual(["R/classes.R:Club.describe:INFERRED", "R/classes.R:Squad.describe:INFERRED"]);
  });
});
