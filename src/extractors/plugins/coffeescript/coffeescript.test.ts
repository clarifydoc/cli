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
    "process = (order, opts) ->",
    "  ### block comment: notCalled() ###",
    "  if order.total is 0 and not opts.force then return",
    "  save order, force: true",
    "  @audit(order) for order in [order] when order?",
    "  fmt = (x) -> x.toFixed 2",
    "  log fmt order.total",
    "class OrderView extends Backbone.View",
    "  render: ->",
    "    $.ajax",
    "      url: \"/api/orders/#{@model.id}\"",
    "      type: 'DELETE'",
    "      success: => @remove()",
  ].join("\n"));

  it("reads functions and class members, never nested callbacks or locals", () => {
    expect(a.functions.map((f) => f.name)).toEqual(["process"]);
    expect(a.classes.map((c) => [c.name, c.extends, c.methods.map((m) => m.name)])).toEqual([["OrderView", "View", ["render"]]]);
  });

  it("reads implicit and parenthesized calls — never keywords or comments", () => {
    // A local function's calls (`fmt`'s `x.toFixed`) belong to its enclosing function.
    expect(calls(a, "process")).toEqual(["save", "this.audit", "x.toFixed", "log", "fmt"]);
  });

  it("reads a multi-line $.ajax call", () => {
    expect(a.dataSources.map((d) => `${d.name}@${d.line}`)).toEqual(["DELETE /api/orders/{id}@11"]);
  });

  it("reads require bindings as imports", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["./store", ["save"]]]);
  });
});

describe("CoffeeScript routes and data access", () => {
  it("reads Express routes, guards, handlers and mounts", () => {
    const a = analyze([
      "router.get '/', listOrders",
      "router.post '/:id/close', requireLogin, (req, res) ->",
      "  res.sendStatus 204",
      "app.use '/api/orders', orders",
      "robot.router.get '/hubot/status', (req, res) -> res.send 'up'",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware}]`)).toEqual([
      "GET / -> listOrders []",
      "POST /:id/close -> null [requireLogin]",
      "null /api/orders -> orders []",
      "GET /hubot/status -> null []",
    ]);
  });

  it("reads Backbone urls, HTTP clients and SQL in strings", () => {
    const a = analyze([
      "class Orders extends Backbone.Collection",
      "  url: '/api/orders'",
      "fetchOne = (id) -> axios.get \"/api/orders/#{id}\"",
      "closeAll = -> db.query \"UPDATE orders SET status = 'closed'\"",
      "label = 'Select a file from the list'",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}`)).toEqual([
      "api-call GET /api/orders", "api-call GET /api/orders/{id}", "database UPDATE orders",
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
      "    SELECT id FROM orders",
      "  \"\"\"",
    ].join("\n"));
    expect(calls(a, "fail")).toEqual(["Error"]);
    expect(a.dataSources.map((d) => `${d.name} ${d.entity}@${d.line}`)).toEqual(["SELECT orders@9"]);
  });

  it("reads only the code of a literate file", () => {
    const a = analyze("Call the server and render the result.\n\n    render = (x) -> show x\n", "src/view.litcoffee");
    expect(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["render", ["show"]]]);
  });
});
