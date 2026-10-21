import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "src/app.zig"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "zig-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "zig" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "zig-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("Zig functions, types and imports", () => {
  it("reads functions, container types, methods and fields", async () => {
    const a = await analyze([
      'const std = @import("std");',
      'const db = @import("db.zig");',
      'const Router = @import("router.zig").Router;',
      "pub const Car = struct {",
      "    id: u64,",
      "    total: f64 = 0,",
      "    pub fn close(self: *Car, repo: *db.Repo) !void {",
      "        if (self.total > 0 and repo.ok) try repo.save(self);",
      "    }",
      "    const Line = struct { sku: []const u8 };",
      "};",
      "const Status = enum { open, closed };",
      "pub fn main() !void {",
      "    var car = Car{ .id = 1 };",
      "    try car.close(db.connect());",
      '    std.debug.print("done", .{});',
      "}",
      "fn helper() void {}",
      'test "closes" { try std.testing.expect(true); }',
    ].join("\n"));
    expect(a.functions.map((f) => [f.name, f.isExported, f.returnType, f.calls.map((c) => c.name)])).toEqual([
      ["main", true, "!void", ["car.close", "db.connect", "std.debug.print"]],
      ["helper", false, "void", []],
    ]);
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.properties.map((p) => `${p.name}:${p.type}`), c.methods.map((m) => m.name)])).toEqual([
      ["Car", "class", ["id:u64", "total:f64"], ["close"]],
      ["Line", "class", ["sku:[]const u8"], []],
      ["Status", "enum", ["open:null", "closed:null"], []],
    ]);
    const close = a.classes[0]!.methods[0]!;
    expect(close.params).toEqual([{ name: "repo", type: "*db.Repo", defaultValue: null }]);
    expect(close.calls.map((c) => c.name)).toEqual(["repo.save"]);
    expect(a.complexities?.find((c) => c.functionName.endsWith("close"))?.complexity).toBe(3);
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["std", ["std"]], ["./db.zig", ["db"]], ["./router.zig", ["Router"]]]);
    expect(a.exports.map((e) => `${e.kind} ${e.name}`)).toEqual(["class Car", "function main"]);
  });

  it("reads a file that declares fields as a struct named after the file", async () => {
    const a = await analyze(["id: u64,", "name: []const u8,", "pub fn init(id: u64) @This() {", "    return .{ .id = id, .name = \"\" };", "}"].join("\n"), "src/Driver.zig");
    expect(a.functions).toEqual([]);
    expect(a.classes.map((c) => [c.name, c.properties.map((p) => p.name), c.methods.map((m) => m.name)])).toEqual([["Driver", ["id", "name"], ["init"]]]);
  });
});

describe("Zig routes and data access", () => {
  it("reads http.zig routes and groups, tokamak decl literals and zap endpoints", async () => {
    const a = await analyze([
      "pub fn main() !void {",
      "    var router = try server.router(.{});",
      '    router.get("/api/cars/:id", getCar, .{});',
      '    var admin = router.group("/admin", .{});',
      '    admin.post("/cars/:id/close", closeCar, .{});',
      '    try zrouter.handle_func_unbound("/health", health);',
      "}",
      'const routes = &.{ .get("/", index), .group("/api", &.{ .get("/players", listPlayers) }) };',
      "const PlayerEndpoint = struct {",
      '    path: []const u8 = "/players",',
      "    pub fn get(self: *PlayerEndpoint, r: zap.Request) !void { _ = self; _ = r; }",
      "};",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /api/cars/{id} -> getCar",
      "POST /admin/cars/{id}/close -> closeCar",
      "null /health -> health",
      "GET / -> index",
      "GET /api/players -> listPlayers",
      "GET /players -> PlayerEndpoint.get",
    ]);
  });

  it("reads jetzig views by file path", async () => {
    const a = await analyze([
      "pub fn index(request: *jetzig.Request) !jetzig.View { return request.render(.ok); }",
      "pub fn get(id: []const u8, request: *jetzig.Request) !jetzig.View { _ = id; return request.render(.ok); }",
      "pub fn post(request: *jetzig.Request) !jetzig.View { return request.render(.created); }",
    ].join("\n"), "src/app/views/cars.zig");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /cars -> index", "GET /cars/{id} -> get", "POST /cars -> post",
    ]);
  });

  it("reads SQL in strings and multiline strings, and std.http.Client calls", async () => {
    const a = await analyze([
      "fn load(conn: *pg.Conn, client: *std.http.Client) !void {",
      "    _ = try conn.query(",
      "        \\\\SELECT id, total",
      "        \\\\FROM cars WHERE id = $1",
      "    , .{1});",
      '    _ = try conn.exec("DELETE FROM sessions WHERE id = $1", .{2});',
      '    _ = try client.fetch(.{ .location = .{ .url = "https://crm.example.com/v2/drivers" }, .method = .POST });',
      '    const uri = try std.Uri.parse("https://crm.example.com/v2/cars");',
      "    var req = try client.open(.GET, uri, .{});",
      '    const msg = "Select a file from the list";',
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}@${d.line}`)).toEqual([
      "database SELECT cars@3",
      "database DELETE FROM sessions@6",
      "api-call POST https://crm.example.com/v2/drivers@7",
      "api-call GET https://crm.example.com/v2/cars@9",
    ]);
  });
});

describe("Zig packages", () => {
  it("reads build.zig.zon dependencies, a tagged URL's version, and keeps URLs whole", async () => {
    const { zigPackageManager } = await import("./package-manifests.js");
    const zon = [
      ".{",
      "    .name = .shop,",
      "    .dependencies = .{",
      '        .zap = .{ .url = "https://github.com/zigzap/zap/archive/v0.9.1.tar.gz", .hash = "x" }, // web',
      '        .@"zig-clap" = .{ .url = "git+https://github.com/Hejsil/zig-clap#0d4a7cf", .hash = "y" },',
      '        .pg = .{ .path = "../pg" },',
      "    },",
      "}",
    ].join("\n");
    const pkgs = zigPackageManager.manifests[0]!.parse(zon, { declaredIn: "build.zig.zon" } as never);
    expect((pkgs as Array<{ name: string; version: string | null }>).map((p) => `${p.name}@${p.version}`)).toEqual(["zap@0.9.1", "zig-clap@null", "pg@null"]);
  });
});
