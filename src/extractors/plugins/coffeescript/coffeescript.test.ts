import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/app.coffee"): FileAnalysis {
  const pre = pluginFor("coffeescript")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "coffeescript");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const calls = (a: FileAnalysis, name: string) =>
  [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name)?.calls.map((c) => c.name);

describe("CoffeeScript functions and calls", () => {
  const a = analyze([
    "{ save } = require './store'",
    "process = (car, opts) ->",
    "  ### block comment: notCalled() ###",
    "  if car.total is 0 and not opts.force then return",
    "  save car, force: true",
    "  @audit(car) for car in [car] when car?",
    "  fmt = (x) -> x.toFixed 2",
    "  log fmt car.total",
    "class CarView extends Backbone.View",
    "  render: ->",
    "    $.ajax",
    "      url: \"/api/cars/#{@model.id}\"",
    "      type: 'DELETE'",
    "      success: => @remove()",
  ].join("\n"));

  it("reads functions and class members, never nested callbacks or locals", () => {
    expect(a.functions.map((f) => f.name)).toEqual(["process"]);
    expect(a.classes.map((c) => [c.name, c.extends, c.methods.map((m) => m.name)])).toEqual([["CarView", "View", ["render"]]]);
  });

  it("reads implicit and parenthesized calls — never keywords or comments", () => {
    // A local function's calls (`fmt`'s `x.toFixed`) belong to its enclosing function.
    expect(calls(a, "process")).toEqual(["save", "this.audit", "x.toFixed", "log", "fmt"]);
  });

  it("reads a multi-line $.ajax call", () => {
    expect(a.dataSources.map((d) => `${d.name}@${d.line}`)).toEqual(["DELETE /api/cars/{id}@11"]);
  });

  it("reads require bindings as imports", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["./store", ["save"]]]);
  });
});

describe("CoffeeScript routes and data access", () => {
  it("reads Express routes, guards, handlers and mounts", () => {
    const a = analyze([
      "router.get '/', listCars",
      "router.post '/:id/close', requireLogin, (req, res) ->",
      "  res.sendStatus 204",
      "app.use '/api/cars', cars",
      "robot.router.get '/hubot/status', (req, res) -> res.send 'up'",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware}]`)).toEqual([
      "GET / -> listCars []",
      "POST /:id/close -> null [requireLogin]",
      "null /api/cars -> cars []",
      "GET /hubot/status -> null []",
    ]);
  });

  it("reads Backbone urls, HTTP clients and SQL in strings", () => {
    const a = analyze([
      "class Cars extends Backbone.Collection",
      "  url: '/api/cars'",
      "fetchOne = (id) -> axios.get \"/api/cars/#{id}\"",
      "closeAll = -> db.query \"UPDATE cars SET status = 'closed'\"",
      "label = 'Select a file from the list'",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}`)).toEqual([
      "api-call GET /api/cars", "api-call GET /api/cars/{id}", "database UPDATE cars",
    ]);
  });

  it("never reads a heredoc's or heregex's text as code", () => {
    const a = analyze([
      "fail = ->",
      "  throw new Error \"\"\"",
      "    Unable to find the file",
      "  \"\"\"",
      "  re = ///",
      "    match this text  # a heregex comment",
      "  ///",
      "  q = \"\"\"",
      "    SELECT id FROM cars",
      "  \"\"\"",
    ].join("\n"));
    expect(calls(a, "fail")).toEqual(["Error"]);
    expect(a.dataSources.map((d) => `${d.name} ${d.entity}@${d.line}`)).toEqual(["SELECT cars@9"]);
  });

  it("reads only the code of a literate file", () => {
    const a = analyze("Call the server and render the result.\n\n    render = (x) -> show x\n", "src/view.litcoffee");
    expect(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["render", ["show"]]]);
  });
});
