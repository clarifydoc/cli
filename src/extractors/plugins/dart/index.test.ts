import { describe, it, expect } from "vitest";
import { dartSpec } from "./index.js";
import {
  extractFunctionsWithSpec,
  extractImportsWithSpec,
} from "../shared/regex-base.js";

const fns = (src: string) => extractFunctionsWithSpec(src.split("\n"), dartSpec);
const fnNames = (src: string) => fns(src).map((f) => f.name);
const classes = (src: string) => dartSpec.extractClasses!(src.split("\n"), []);
const imports = (src: string) => extractImportsWithSpec(src.split("\n"), dartSpec);
const dataSources = (src: string) => dartSpec.extractDataSources!(src.split("\n"), []);
const routes = (src: string) => dartSpec.extractRoutes!(src.split("\n"), []);

describe("dartSpec — functions", () => {
  it("captures typed top-level functions, methods and arrow bodies", () => {
    const f = fns(`
      void main() {
        runApp(MyApp());
      }

      Future<Player> fetchPlayer(int id) async {
        return Player.fromJson({});
      }

      int add(int a, int b) => a + b;

      Widget build(BuildContext context) {
        return Container();
      }
    `);
    const byName = Object.fromEntries(f.map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(["add", "build", "fetchPlayer", "main"]);
    expect(byName["fetchPlayer"]).toMatchObject({ isAsync: true, returnType: "Future<Player>" });
    expect(byName["add"]).toMatchObject({ returnType: "int" });
    expect(byName["main"]!.returnType).toBeNull(); // void → null
  });

  it("marks leading-underscore names as private (not exported)", () => {
    const f = fns(`
      String _secret() => 'x';
      String publicName() => 'y';
    `);
    expect(f.find((x) => x.name === "_secret")!.isExported).toBe(false);
    expect(f.find((x) => x.name === "publicName")!.isExported).toBe(true);
  });

  it("does NOT mistake Flutter trailing-closure calls for declarations", () => {
    const names = fnNames(`
      void build() {
        setState(() {
          counter++;
        });
        Future.delayed(Duration(seconds: 1), () {
          doThing();
        });
        items.where((e) {
          return e.active;
        });
      }
    `);
    // Only the real declaration `build` — never setState/Future/where/doThing.
    expect(names).toEqual(["build"]);
  });

  it("does NOT mistake control flow or assignments for declarations", () => {
    const names = fnNames(`
      void run() {
        if (ready) {
          start();
        }
        for (var x in items) {
          process(x);
        }
        while (going) {
          tick();
        }
        final cb = (int i) {
          return i;
        };
      }
    `);
    expect(names).toEqual(["run"]);
  });
});

describe("dartSpec — classes", () => {
  it("captures classes, mixins, extensions, enums with extends/with/implements", () => {
    const c = classes(`
      abstract class Repository<T> {
        Future<List<T>> getAll();
      }

      class HomePage extends StatefulWidget with WidgetsBindingObserver implements Disposable {
        Widget build(BuildContext context) {
          return Container();
        }
      }

      mixin Loggable on Object {
        void log(String m) => print(m);
      }

      extension StringExt on String {
        String shout() => toUpperCase();
      }

      enum Status { active, inactive }
    `);
    const byName = Object.fromEntries(c.map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(
      ["HomePage", "Loggable", "Repository", "StringExt", "Status"].sort(),
    );
    expect(byName["HomePage"]).toMatchObject({ extends: "StatefulWidget" });
    expect(byName["HomePage"]!.implements.sort()).toEqual(["Disposable", "WidgetsBindingObserver"]);
    expect(byName["Loggable"]).toMatchObject({ extends: "Object" });
  });
});

describe("dartSpec — imports", () => {
  it("captures package/dart/relative imports with aliases and show clauses", () => {
    const imp = imports(`
      import 'package:flutter/material.dart';
      import 'package:http/http.dart' as http;
      import 'dart:convert';
      import '../models/player.dart' show Player, Game;
      export 'src/widget.dart';
    `);
    const bySource = Object.fromEntries(imp.map((x) => [x.source, x]));
    expect(bySource["package:flutter/material.dart"]).toBeDefined();
    expect(bySource["package:http/http.dart"]!.specifiers).toEqual(["http"]);
    expect(bySource["../models/player.dart"]!.specifiers).toEqual(["Player", "Game"]);
    expect(bySource["dart:convert"]).toBeDefined();
  });
});

describe("dartSpec — data sources", () => {
  it("reads a client call whose verb is on the next line, and no Drift statement from a Bloc event or a cascade (real-repo FP)", () => {
    const ds = dataSources(`
      final response = await http
          .get(Uri.parse('https://api.example.com/fixtures'), headers: headers);
      context.read<MatchBloc>().add(MatchEvent.delete(widget.match));
      final delta = Delta()..delete(keyword.length);
      final rows = await (select(db.clubEntity)).get();
    `);
    expect(ds.filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target} @${d.line}`)).toEqual([
      "http.get https://api.example.com/fixtures @3",
    ]);
    expect(ds.filter((d) => d.kind === "database").map((d) => d.entity)).toEqual(["ClubEntity"]);
  });

  it("surfaces http/dio client calls as api-call with the URL target", () => {
    const ds = dataSources(`
      final res = await http.get(Uri.parse('https://api.example.com/players'));
      final r2 = await _dio.post('/cars', data: body);
      final r3 = await apiClient.delete('/balls/42');
    `).filter((d) => d.kind === "api-call");
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    expect(byName["http.get"]).toMatchObject({ target: "https://api.example.com/players" });
    expect(byName["_dio.post"]).toMatchObject({ target: "/cars" });
    expect(byName["apiClient.delete"]).toMatchObject({ target: "/balls/42" });
  });

  it("does NOT treat non-client receivers as HTTP calls", () => {
    const ds = dataSources(`
      list.get(0);
      map.put('k', 'v');
    `).filter((d) => d.kind === "api-call");
    expect(ds).toHaveLength(0);
  });

  it("surfaces Firestore collections and sqflite tables as database with entity", () => {
    const ds = dataSources(`
      final snap = await FirebaseFirestore.instance.collection('players').get();
      await db.insert('cars', row);
      final rows = await db.query('parts', where: 'id = ?');
    `).filter((d) => d.kind === "database");
    const entities = ds.map((d) => d.entity).sort();
    expect(entities).toEqual(["cars", "parts", "players"]);
  });
});

describe("dartSpec — routes", () => {
  it("captures shelf_router API routes", () => {
    const r = routes(`
      final router = Router();
      router.get('/players', listPlayers);
      router.post('/players', createPlayer);
      app.delete('/players/<id>', deletePlayer);
    `);
    expect(r).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/players", httpMethod: "GET", handler: "listPlayers", kind: "api" }),
        expect.objectContaining({ path: "/players", httpMethod: "POST", handler: "createPlayer" }),
        expect.objectContaining({ path: "/players/<id>", httpMethod: "DELETE", handler: "deletePlayer" }),
      ]),
    );
  });

  it("captures GoRouter declarative routes as frontend screens", () => {
    const r = routes(`
      GoRoute(path: '/home', builder: (context, state) => const HomePage()),
      GoRoute(path: '/profile/:id', builder: (c, s) => ProfilePage()),
    `);
    expect(r).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/home", kind: "frontend", handler: "HomePage" }),
        expect.objectContaining({ path: "/profile/:id", kind: "frontend", handler: "ProfilePage" }),
      ]),
    );
  });

  it("does not treat dio client calls (relative path) as server routes", () => {
    const r = routes(`final r = await dio.get('/players');`);
    expect(r).toHaveLength(0);
  });
});

describe("Flutter closure handlers", () => {
  it("names an inline closure handler and gives it the closure's calls; a forwarding closure keeps its target", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `class BackupPage extends ConsumerWidget {
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(children: [
      ElevatedButton(
        onPressed: () => unawaited(ref.read(backupProvider.notifier).startBackup()),
        child: Text('Start'),
      ),
      IconButton(onPressed: () => _save(context), icon: Icon(Icons.save)),
      ListTile(
        onTap: () {
          setState(() => selected = true);
          context.pushRoute(const SettingsRoute());
        },
      ),
    ]);
  }
}`;
    const a = extractWithRegex(src, "lib/backup.page.dart", "dart");
    expect(a.interactiveElements.map((e) => `${e.event}@${e.line}=${e.handler}`)).toEqual([
      "onPressed@5=<onPressed@5>",
      "onPressed@8=_save",
      "onTap@10=<onTap@10>",
    ]);
    const fn = (n: string) => a.functions.find((f) => f.name === n);
    expect(fn("<onPressed@5>")?.calls.map((c) => [c.name, c.receiverQualifier ?? null])).toEqual(
      expect.arrayContaining([
        ["unawaited", null],
        ["ref.read(backupProvider.notifier).startBackup", "backupProvider"],
      ]),
    );
    expect(fn("<onTap@10>")?.calls.map((c) => c.name)).toContain("context.pushRoute");
  });
});

describe("dartSpec — request bodies", () => {
  it("states the map package:http's jsonEncode and Dio's data send, across lines and through a local", () => {
    const rows = dataSources(`
      Future<void> save(String name) async {
        await http.post(
          Uri.parse('https://api.example.com/players'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'name': name, 'age': 3, 'tags': ['a'], 'address': {'city': 'x'}}),
        );
        final payload = {
          'title': 'hello',
          'done': false,
          ...extra,
        };
        await dio.put('/api/drills/1', data: payload);
        await dio.post('/api/ping');
        await dio.get('/api/drills', queryParameters: {'page': 1});
      }
    `).filter((d) => d.kind === "api-call").map((d) => [d.name, d.requestBody ?? null]);
    expect(rows).toEqual([
      ["http.post", { type: "object", properties: { name: {}, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, address: { type: "object", properties: { city: { type: "string" } } } } }],
      ["dio.put", { type: "object", properties: { title: { type: "string" }, done: { type: "boolean" } }, additionalProperties: true }],
      ["dio.post", null],
      ["dio.get", null],
    ]);
  });
});
