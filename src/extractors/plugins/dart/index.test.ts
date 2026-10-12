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

      Future<User> fetchUser(int id) async {
        return User.fromJson({});
      }

      int add(int a, int b) => a + b;

      Widget build(BuildContext context) {
        return Container();
      }
    `);
    const byName = Object.fromEntries(f.map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(["add", "build", "fetchUser", "main"]);
    expect(byName["fetchUser"]).toMatchObject({ isAsync: true, returnType: "Future<User>" });
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
      import '../models/user.dart' show User, Post;
      export 'src/widget.dart';
    `);
    const bySource = Object.fromEntries(imp.map((x) => [x.source, x]));
    expect(bySource["package:flutter/material.dart"]).toBeDefined();
    expect(bySource["package:http/http.dart"]!.specifiers).toEqual(["http"]);
    expect(bySource["../models/user.dart"]!.specifiers).toEqual(["User", "Post"]);
    expect(bySource["dart:convert"]).toBeDefined();
  });
});

describe("dartSpec — data sources", () => {
  it("surfaces http/dio client calls as api-call with the URL target", () => {
    const ds = dataSources(`
      final res = await http.get(Uri.parse('https://api.example.com/users'));
      final r2 = await _dio.post('/orders', data: body);
      final r3 = await apiClient.delete('/items/42');
    `).filter((d) => d.kind === "api-call");
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    expect(byName["http.get"]).toMatchObject({ target: "https://api.example.com/users" });
    expect(byName["_dio.post"]).toMatchObject({ target: "/orders" });
    expect(byName["apiClient.delete"]).toMatchObject({ target: "/items/42" });
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
      final snap = await FirebaseFirestore.instance.collection('users').get();
      await db.insert('orders', row);
      final rows = await db.query('products', where: 'id = ?');
    `).filter((d) => d.kind === "database");
    const entities = ds.map((d) => d.entity).sort();
    expect(entities).toEqual(["orders", "products", "users"]);
  });
});

describe("dartSpec — routes", () => {
  it("captures shelf_router API routes", () => {
    const r = routes(`
      final router = Router();
      router.get('/users', listUsers);
      router.post('/users', createUser);
      app.delete('/users/<id>', deleteUser);
    `);
    expect(r).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/users", httpMethod: "GET", handler: "listUsers", kind: "api" }),
        expect.objectContaining({ path: "/users", httpMethod: "POST", handler: "createUser" }),
        expect.objectContaining({ path: "/users/<id>", httpMethod: "DELETE", handler: "deleteUser" }),
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
    const r = routes(`final r = await dio.get('/users');`);
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
