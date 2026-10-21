import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dartSpec } from "./index.js";
import { dartUrlExpr, extractDartPathArgCalls } from "./request-wrappers.js";
import { analyze } from "../../../core/analyzer.js";
import { denormalizeProject } from "../../../core/element-registry.js";

const lines = (src: string) => src.split("\n");
const dataSources = (src: string) => dartSpec.extractDataSources!(lines(src), []).filter((d) => d.kind === "api-call");
const classes = (src: string) => dartSpec.extractClasses!(lines(src), []);

/** A project's own request wrapper, the shape real Flutter apps funnel every call through. */
const WRAPPER = `import 'package:dio/dio.dart';

class ApiConnection {
  Future<Response> request(RequestType requestType, String url,
      {Body? body}) async {
    Response response = Response(requestOptions: RequestOptions(path: ''));
    var completeUrl = this.getBaseUrl() + url;
    if (requestType == RequestType.GET) {
      try {
        response = await this.getDio().get(completeUrl);
      } catch (e) {
        log('$e');
      }
    } else if (requestType == RequestType.DELETE) {
      response = await this.getDio().delete(completeUrl);
    } else if (requestType == RequestType.POST && body != null) {
      response = await this.getDio().post(completeUrl, data: body.toJson());
    } else if (requestType == RequestType.POST && body == null) {
      response = await this.getDio().post(completeUrl);
    } else if (requestType == RequestType.PUT) {
      response = await this.getDio().put(completeUrl, data: body);
    }
    return response;
  }

  String getBaseUrl() => 'https://example.com';

  Dio getDio() => Dio();
}

enum RequestType { GET, POST, PUT, DELETE }
`;

const SETTINGS = `class Settings {
  static const apiBasePath = "mobile"; // "mobile" locally, "app" behind the proxy
  static const String tag = 'league';
  final int timeout = 30;
}
`;

const PAGE = `import 'package:flutter/material.dart';
import '../util/ApiConnection.dart';
import '../util/Settings.dart';

class FixturesPage extends StatefulWidget {
  @override
  State<FixturesPage> createState() => _FixturesPageState();
}

class _FixturesPageState extends State<FixturesPage> {
  Future<void> _checkOpen() async {
    var response = await ApiConnection().request(
        RequestType.GET,
        '/\${Settings.apiBasePath}/clubs/isTransferWindowOpen');
  }

  Future<void> _sign(int id) async {
    var api = ApiConnection();
    await api.request(RequestType.POST, '/\${Settings.apiBasePath}/players/$id/sign');
  }
}
`;

describe("Dart request wrapper — per file", () => {
  it("reads a wrapped method signature as a method with its parameters", () => {
    const [cls] = classes(WRAPPER);
    const request = cls!.methods.find((m) => m.name === "request");
    expect(request?.params.map((p) => p.name)).toEqual(["requestType", "url", "body"]);
    expect(request).toMatchObject({ line: 4, isAsync: true });
    expect(request!.endLine).toBe(24);
  });

  it("gives the wrapper's client calls the URL its local builds from the parameter", () => {
    const rows = dataSources(WRAPPER);
    expect(rows.map((r) => [r.name, r.target])).toEqual([
      ["getDio().get", "${this.getBaseUrl()}${url}"],
      ["getDio().delete", "${this.getBaseUrl()}${url}"],
      ["getDio().post", "${this.getBaseUrl()}${url}"],
      ["getDio().post", "${this.getBaseUrl()}${url}"],
      ["getDio().put", "${this.getBaseUrl()}${url}"],
    ]);
  });

  it("renders Dart interpolation as holes and leaves the wrapper's call sites to the factory pass", () => {
    const rows = dataSources(`
      final a = await http.get(Uri.parse('$baseUrl/clubs/\${club.id}'));
      final b = await apiConnection.request(RequestType.GET, '/clubs');
      final c = await this.dio.get('/players');
    `);
    expect(rows.map((r) => [r.name, r.target])).toEqual([
      ["http.get", "${baseUrl}/clubs/${club.id}"],
      ["dio.get", "/players"],
    ]);
  });

  it("records each wrapper call site with its path, receiver class and verb", () => {
    const sites = extractDartPathArgCalls(lines(PAGE));
    expect(sites).toEqual([
      { callee: "request", args: [null, "/${Settings.apiBasePath}/clubs/isTransferWindowOpen"], line: 12, receiverType: "ApiConnection", method: "GET" },
      { callee: "request", args: [null, "/${Settings.apiBasePath}/players/${id}/sign"], line: 19, receiverType: "ApiConnection", method: "POST" },
    ]);
  });

  it("does not record client requests, URI parsing or navigation as wrapper calls", () => {
    const sites = extractDartPathArgCalls(lines(`
      await dio.get('/players');
      final u = Uri.parse('/clubs/1');
      Navigator.pushNamed(context, '/club/detail');
      context.go('/league/table');
    `));
    expect(sites).toEqual([]);
  });

  it("keeps a class's string constants as its field values", () => {
    const [cls] = classes(SETTINGS);
    expect(cls!.fieldValues).toEqual({ apiBasePath: "mobile", tag: "league" });
  });

  it("joins string literals and operands of a `+` into one URL", () => {
    expect(dartUrlExpr("this.getBaseUrl() + url")).toBe("${this.getBaseUrl()}${url}");
    expect(dartUrlExpr("'/clubs/' + ids[0]")).toBeNull();
    expect(dartUrlExpr("'/clubs/' + clubId")).toBe("/clubs/${clubId}");
    expect(dartUrlExpr("r'/raw/$x'")).toBe("/raw/$x");
  });
});

describe("Dart request wrapper — end to end", () => {
  let dir: string;
  let summary: Record<string, any>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dart-wrapper-"));
    const app = join(dir, "app");
    await mkdir(join(app, "lib", "util"), { recursive: true });
    await mkdir(join(app, "lib", "pages"), { recursive: true });
    await writeFile(join(app, "pubspec.yaml"), "name: league_app\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n");
    await writeFile(join(app, "lib", "util", "ApiConnection.dart"), WRAPPER);
    await writeFile(join(app, "lib", "util", "Settings.dart"), SETTINGS);
    await writeFile(join(app, "lib", "pages", "FixturesPage.dart"), PAGE);
    const api = join(dir, "api");
    await mkdir(api, { recursive: true });
    await writeFile(join(api, "package.json"), JSON.stringify({ name: "api", dependencies: { express: "4.0.0" } }));
    await writeFile(
      join(api, "server.js"),
      'const express = require("express");\nconst app = express();\n' +
        'app.get("/mobile/clubs/isTransferWindowOpen", (req, res) => res.json({}));\n' +
        'app.post("/mobile/players/:id/sign", (req, res) => res.json({}));\n' +
        'app.get("/mobile/players/:id/sign", (req, res) => res.json({}));\n',
    );
    const out = join(dir, "out");
    await analyze({ projectRoot: dir, outputDir: out, incremental: false, lsp: false, gitHistory: false });
    summary = denormalizeProject(JSON.parse(await readFile(join(out, "project-summary.json"), "utf8"))) as Record<string, any>;
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns each call site into a request with the verb it names and the class constant resolved", () => {
    const viaWrapper = (summary.apiCalls as any[])
      .filter((c) => c.via === "request")
      .map((c) => [c.filePath, c.line, c.name, c.target]);
    expect(viaWrapper).toEqual([
      ["app/lib/pages/FixturesPage.dart", 12, "GET", "/mobile/clubs/isTransferWindowOpen"],
      ["app/lib/pages/FixturesPage.dart", 19, "POST", "/mobile/players/${id}/sign"],
    ]);
  });

  it("links them to the routes serving that method", () => {
    const joined = (summary.apiRouteLinks as any[])
      .filter((l) => l.source === "app/lib/pages/FixturesPage.dart")
      .map((l) => `${l.method} ${l.routePath}`)
      .sort();
    expect(joined).toEqual(["GET /mobile/clubs/isTransferWindowOpen", "POST /mobile/players/:id/sign"]);
  });
});
