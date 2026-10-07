import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "lib/Shop.rakumod"): FileAnalysis {
  const pre = pluginFor("raku")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "raku");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fn = (a: FileAnalysis, name: string) => [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name);

describe("Raku routines, classes and imports", () => {
  const a = analyze([
    "use v6.d;",
    "use lib 'lib';",
    "use Cro::HTTP::Router;",
    "need DBIish;",
    "",
    "role Repo { method find(Int $id) { ... } }",
    "",
    "class OrderService is BaseService does Repo {",
    "    has Str $.name is rw = 'orders';",
    "    has Repo $!repo is required;",
    "    has @.items;",
    "",
    "    method close-order(Int $id, Bool :$force = False --> Order) {",
    "        if ($force) { self.audit($id) }",
    "        my $order = $!repo.find($id);",
    "        $order.mark-closed;",
    "        notify-customer($order);",
    "    }",
    "    method !audit($id) { }",
    "}",
    "",
    "sub notify-customer(Order $order) is export { say \"closed\"; }",
    "multi greet(Str $who) { greet-all([$who]) }",
    "",
    "=begin pod",
    "Call close-order() when done.",
    "=end pod",
  ].join("\n"));

  it("reads classes, roles and attributes", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.implements, c.properties.map((p) => `${p.name}:${p.type}:${p.visibility}`)])).toEqual([
      ["Repo", "interface", null, [], []],
      ["OrderService", "class", "BaseService", ["Repo"], ["name:Str:public", "repo:Repo:private", "items:Array:public"]],
    ]);
  });

  it("reads hyphenated routines, typed params and return types", () => {
    const close = fn(a, "close-order")!;
    expect(close.params).toEqual([
      { name: "id", type: "Int", defaultValue: null },
      { name: "force", type: "Bool", defaultValue: "False" },
    ]);
    expect(close.returnType).toBe("Order");
    expect(close.calls.map((c) => c.name)).toEqual(["self.audit", "repo.find", "order.mark-closed", "notify-customer"]);
    expect(a.functions.map((f) => f.name)).toEqual(["notify-customer", "greet"]);
    expect(fn(a, "greet")!.calls.map((c) => c.name)).toEqual(["greet-all"]);
  });

  it("reads modules as imports, never pragmas or Pod", () => {
    expect(a.imports.map((i) => i.source)).toEqual(["Cro::HTTP::Router", "DBIish"]);
    expect(a.functions.find((f) => f.name === "<setup>")).toBeUndefined();
  });

  it("reads a unit class as the whole file", () => {
    const u = analyze(["unit class Shop::Customer;", "has Str $.email;", "method greet() { say-hi(self.email) }"].join("\n"));
    expect(u.classes.map((c) => [c.name, c.methods.map((m) => m.name), c.properties.map((p) => p.name)])).toEqual([["Shop::Customer", ["greet"], ["email"]]]);
  });
});

describe("Raku routes and data access", () => {
  it("reads Cro routes, includes and Humming-Bird routes", () => {
    const a = analyze([
      "sub routes() is export {",
      "    route {",
      "        get -> { content 'text/plain', 'ok' }",
      "        get -> 'orders', Int $id { content 'application/json', find-order($id) }",
      "        post -> 'orders', Int $id, 'close', Str :$reason { close-order($id) }",
      "        include 'api' => api-routes();",
      "    }",
      "}",
      "sub api-routes() {",
      "    route {",
      "        get -> 'files', *@path { static 'public', @path }",
      "    }",
      "}",
      "get('/health/:check', -> $request, $response { $response.html(render-health()) });",
    ].join("\n"), "lib/Routes.rakumod");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET / [content]",
      "GET /orders/{id} [find-order,content]",
      "POST /orders/{id}/close [close-order]",
      "GET /api/files/* [static]",
      "GET /health/{check} [render-health,response.html]",
    ]);
  });

  it("reads SQL in strings and heredocs, and HTTP client calls", () => {
    const a = analyze([
      "sub load($dbh, $id) {",
      "    my $sth = $dbh.prepare(q:to/SQL/);",
      "        SELECT id, total",
      "        FROM orders WHERE id = ?",
      "        SQL",
      "    $dbh.execute('DELETE FROM sessions WHERE id = ?', $id);",
      "    my $crm = Cro::HTTP::Client.new(base-uri => 'https://crm.example.com/v2');",
      "    await $crm.post('/orders/closed', body => { :$id });",
      "    await Cro::HTTP::Client.get(\"https://crm.example.com/v2/customers/$id\");",
      "    my $msg = 'Select a file from the list';",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}@${d.line}`)).toEqual([
      "database SELECT orders@2",
      "database DELETE FROM sessions@6",
      "api-call POST https://crm.example.com/v2/orders/closed@8",
      "api-call GET https://crm.example.com/v2/customers/{id}@9",
    ]);
    expect(fn(a, "load")!.calls.map((c) => c.name)).not.toContain("FROM");
  });
});
