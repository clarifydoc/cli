import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { dartSpec } from "./index.js";
import { dartRequestSchema as h, extractDartRequestAccess } from "./request-schema.js";

const classes = (src: string) => dartSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), dartSpec);
const routes = (src: string) => dartSpec.extractRoutes!(src.split("\n"), []);

describe("Dart request-schema hooks", () => {
  it("classifies scalars, collections, maps, nullables and unknown objects", () => {
    expect(h.unwrapNullable("DateTime?")).toEqual({ type: "DateTime", nullable: true });
    expect(h.describeType("String")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("int")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("num")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("DateTime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("Duration")).toEqual({ kind: "scalar", schema: { type: "string", format: "duration" } });
    expect(h.describeType("List<String>")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("Set<Tag>")).toEqual({ kind: "array", element: "Tag" });
    expect(h.describeType("Map<String, List<int>>")).toEqual({ kind: "map", value: "List<int>" });
    expect(h.describeType("dynamic")).toEqual({ kind: "any" });
    expect(h.describeType("Object")).toEqual({ kind: "any" });
    expect(h.describeType("Address")).toEqual({ kind: "object", name: "Address" });
  });

  it("reads JsonKey names and ignore markers, hides private and static fields", () => {
    const p = (decorators: string[], extra: Record<string, unknown> = {}) => ({
      name: "createdAt", type: "DateTime", visibility: "public" as const, isStatic: false, isReadonly: true, decorators, ...extra,
    });
    expect(h.serializedName(p(["JsonKey(name: 'created_at')"]))).toBe("created_at");
    expect(h.serializedName(p(['JsonKey(name: "created_at", required: true)']))).toBe("created_at");
    expect(h.serializedName(p([]))).toBe("createdAt");
    expect(h.isSerialized(p(["JsonKey(ignore: true)"]))).toBe(false);
    expect(h.isSerialized(p(["JsonKey(includeFromJson: false)"]))).toBe(false);
    expect(h.isSerialized(p([], { name: "_cache" }))).toBe(false);
    expect(h.isSerialized(p([], { isStatic: true }))).toBe(false);
    expect(h.isSerialized(p([]))).toBe(true);
    expect(h.isRequired(p([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(p([]))).toBe(false);
  });

  it("binds a shelf Request to services and says nothing about the rest", () => {
    const route = { path: "/players/<id>", httpMethod: "GET", kind: "api" as const, handler: "_getPlayer", calls: [], middleware: [], line: 1 };
    expect(h.bindParam!({ name: "request", type: "Request", defaultValue: null }, route)).toBe("services");
    expect(h.bindParam!({ name: "id", type: "String", defaultValue: null }, route)).toBeNull();
  });
});

describe("Dart class fields", () => {
  it("takes typed fields with annotations, nullability and initializers; skips method locals", () => {
    const [cls] = classes(
      [
        "class Player {",
        "  final int id;",
        "  @JsonKey(name: 'created_at')",
        "  final DateTime? createdAt;",
        "  @JsonKey(name: 'tag_list') final List<String> tags;",
        "  String? nickname;",
        "  int loginCount = 0;",
        "  static const String table = 'players';",
        "  final Map<String, int> _scores = {",
        "    'a': 1,",
        "  };",
        "  Map<String, dynamic> toJson() {",
        "    final String local = 'x';",
        "    return {};",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(cls.properties.map((p) => [p.name, p.type, p.decorators ?? [], p.isRequired ?? false, p.visibility, p.isStatic])).toEqual([
      ["id", "int", [], true, "public", false],
      ["createdAt", "DateTime?", ["JsonKey(name: 'created_at')"], false, "public", false],
      ["tags", "List<String>", ["JsonKey(name: 'tag_list')"], true, "public", false],
      ["nickname", "String?", [], false, "public", false],
      ["loginCount", "int", [], false, "public", false],
      ["table", "String", [], false, "public", true],
      ["_scores", "Map<String, int>", [], false, "private", false],
    ]);
  });

  it("does not read statements or getters as fields", () => {
    const [cls] = classes(["class A {", "  Router get router {", "    return r;", "  }", "  return x;", "  await y;", "}"].join("\n"));
    expect(cls.properties).toEqual([]);
  });
});

describe("Dart request access", () => {
  it("reads body, typed body, query, header and route params off the request", () => {
    const body = [
      "final body = jsonDecode(await request.readAsString()) as Map<String, dynamic>;",
      "final q = request.url.queryParameters['q'];",
      "final page = request.requestedUri.queryParameters['page'];",
      "final tenant = request.headers['x-tenant'];",
      "final id = request.params['id'];",
    ];
    expect(extractDartRequestAccess(body, { name: "h", params: [{ name: "request", type: "Request", defaultValue: null }] })).toEqual([
      { name: "body", type: null, binding: "body" },
      { name: "q", type: null, binding: "query" },
      { name: "page", type: null, binding: "query" },
      { name: "x-tenant", type: null, binding: "header" },
      { name: "id", type: null, binding: "route" },
    ]);
    expect(extractDartRequestAccess(["final player = Player.fromJson(jsonDecode(await req.readAsString()) as Map<String, dynamic>);"], { name: "h", params: [] })).toEqual([
      { name: "player", type: "Player", binding: "body" },
    ]);
  });

  it("lands on FunctionInfo.requestAccess for a handler method", () => {
    const [fn] = functions(
      [
        "Future<Response> _createPlayer(Request request) async {",
        "  final player = Player.fromJson(jsonDecode(await request.readAsString()) as Map<String, dynamic>);",
        "  return Response(201);",
        "}",
      ].join("\n"),
    );
    expect(fn.requestAccess).toEqual([{ name: "player", type: "Player", binding: "body" }]);
  });
});

describe("shelf Pipeline middleware", () => {
  it("inherits auth middleware from a wrapped Pipeline onto the router's routes", () => {
    const r = routes(`
      final router = Router();
      router.get('/players', _listPlayers);
      router.post('/players', _createPlayer);
      final handler = const Pipeline()
          .addMiddleware(logRequests())
          .addMiddleware(authMiddleware(secret: 'x'))
          .addHandler(router);
    `);
    expect(r.map((x) => x.middleware)).toEqual([
      ["logRequests()", "authMiddleware(secret: 'x')"],
      ["logRequests()", "authMiddleware(secret: 'x')"],
    ]);
    expect(r[0]!.auth).toEqual({ policies: ["authMiddleware"], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(r[0]!.params).toBeUndefined();
  });

  it("classifies a token/jwt middleware as a scheme and leaves other routers alone", () => {
    const r = routes(`
      final router = Router();
      final _router = Router();
      router.get('/health', _health);
      _router.get('/stats', _stats);
      Pipeline().addMiddleware(jwtMiddleware()).addHandler(_router);
    `);
    expect(r.find((x) => x.path === "/health")!.auth).toBeUndefined();
    expect(r.find((x) => x.path === "/stats")!.auth).toEqual({ policies: [], roles: [], schemes: ["jwtMiddleware"], anonymous: false, inherited: true });
  });
});
