import { describe, it, expect } from "vitest";
import { extractCallsFromBody, extractFunctionsWithSpec } from "../shared/regex-base.js";
import { dartSpec } from "./index.js";
import { extractDartDiBindings, extractDartLocalTypes } from "./di.js";

const classes = (src: string, fns = extractFunctionsWithSpec(src.split("\n"), dartSpec)) => dartSpec.extractClasses!(src.split("\n"), fns);
const bindings = (src: string) =>
  extractDartDiBindings(src.split("\n")).map((b) => {
    const { line: _line, ...rest } = b;
    return rest;
  });
const locals = (...body: string[]) => extractDartLocalTypes(body, { name: "f" });
const calls = (line: string) => extractCallsFromBody([line], 0, 1, ["//"], dartSpec.callPatterns);

describe("dart class members", () => {
  it("reads abstract signatures and makes a pure abstract class an interface", () => {
    const [repo] = classes(
      [
        "abstract class UserRepo {",
        "  Future<User?> load(int id);",
        "  Future<User?> find(",
        "    int id,",
        "  );",
        "  String? get(String k);",
        "  int get count;",
        "}",
      ].join("\n"),
    );
    expect(repo!.kind).toBe("interface");
    expect(repo!.methods.map((m) => [m.name, m.line, m.endLine, m.calls.length])).toEqual([
      ["load", 2, 2, 0],
      ["find", 3, 5, 0],
      ["get", 6, 6, 0],
    ]);
  });

  it("makes `abstract interface class` an interface, but not a base class or a concrete `interface class`", () => {
    const found = classes(
      [
        "abstract interface class Repo {",
        "  void a();",
        "}",
        "abstract class Base {",
        "  Base(this.t);",
        "  final String t;",
        "  void a();",
        "  String b() => t;",
        "}",
        "interface class Clock {",
        "  DateTime now() => DateTime.now();",
        "}",
        "mixin Loud {",
        "  void shout();",
        "}",
      ].join("\n"),
    );
    expect(found.map((c) => [c.name, c.kind])).toEqual([
      ["Repo", "interface"],
      ["Base", undefined],
      ["Clock", undefined],
      ["Loud", undefined],
    ]);
  });

  it("reads constructors with their parameters, typing `this.x` from the field", () => {
    const found = classes(
      [
        "class UserService {",
        "  final UserRepo _repo;",
        "  final Cache cache;",
        "  UserService(this._repo, {required this.cache});",
        "}",
        "class Worker {",
        "  final UserRepo _repo;",
        "  Worker(@Named('mem') UserRepo repo) : _repo = repo;",
        "}",
        "class Other {",
        "  final UserRepo _repo;",
        "  const Other(@Named('pg') this._repo) {",
        "    init();",
        "  }",
        "  Other.named(this._repo);",
        "}",
      ].join("\n"),
    );
    const ctor = (c: (typeof found)[number]) => c.methods.find((m) => m.name === c.name)!;
    expect(ctor(found[0]!).params).toEqual([
      { name: "_repo", type: "UserRepo", defaultValue: null },
      { name: "cache", type: "Cache", defaultValue: null },
    ]);
    expect(ctor(found[1]!).params).toEqual([{ name: "repo", type: "UserRepo", defaultValue: null, qualifier: "mem" }]);
    // The key reaches the field the parameter initialises.
    expect(found[1]!.properties[0]).toMatchObject({ name: "_repo", qualifier: "mem" });
    expect(ctor(found[2]!)).toMatchObject({ line: 12, endLine: 14 });
    expect(ctor(found[2]!).calls.map((c) => c.name)).toEqual(["init"]);
    expect(found[2]!.properties[0]).toMatchObject({ name: "_repo", qualifier: "pg" });
    expect(found[2]!.methods.filter((m) => m.name === "Other")).toHaveLength(1);
  });

  it("reads no signature out of an enum's value list", () => {
    const [planet] = classes(["enum Planet {", "  mercury(3.3),", "  venus(4.8);", "  const Planet(this.mass);", "  final double mass;", "}"].join("\n"));
    expect(planet!.methods).toEqual([]);
  });

  it("types an untyped field from its initializer, and keys a typed one", () => {
    const [screen] = classes(
      [
        "class Screen {",
        "  final _repo2 = getIt.get<UserRepo>();",
        "  late final local = PgRepo();",
        "  final UserRepo named = getIt<UserRepo>(instanceName: 'pg');",
        "  final createdAt = DateTime.now();",
        "  var count = 0;",
        "}",
      ].join("\n"),
    );
    expect(screen!.properties.map((p) => [p.name, p.type, p.qualifier])).toEqual([
      ["_repo2", "UserRepo", undefined],
      ["local", "PgRepo", undefined],
      ["named", "UserRepo", "pg"],
    ]);
  });
});

describe("dart locals", () => {
  it("types locals from declarations, constructions and lookups", () => {
    expect(
      locals(
        "final a = ConcRepo();",
        "UserRepo b = PgRepo();",
        "final ConcRepo c = ConcRepo();",
        "var d = PgRepo();",
        "final r = getIt<UserRepo>();",
        "final r2 = GetIt.I.get<UserRepo>(instanceName: 'mem');",
        "final UserRepo r3 = GetIt.instance<UserRepo>();",
        "final c1 = context.read<Cache>();",
        "final c2 = Provider.of<Cache>(context, listen: false);",
        "final g = Get.find<Clock>(tag: 'fake');",
        "final k = KiwiContainer().resolve<UserRepo>('mem');",
        "final p = ref.read(repoProvider);",
        "final x = await getIt.getAsync<Db>();",
        "final y = compute(1);",
        "return repo.find(id);",
        "await repo.save(u);",
      ),
    ).toEqual([
      { name: "a", type: "ConcRepo" },
      { name: "b", type: "UserRepo" },
      { name: "c", type: "ConcRepo" },
      { name: "d", type: "PgRepo" },
      { name: "r", type: "UserRepo" },
      { name: "r2", type: "UserRepo", qualifier: "mem" },
      { name: "r3", type: "UserRepo" },
      { name: "c1", type: "Cache" },
      { name: "c2", type: "Cache" },
      { name: "g", type: "Clock", qualifier: "fake" },
      { name: "k", type: "UserRepo", qualifier: "mem" },
      { name: "p", type: "", qualifier: "repoProvider" },
      { name: "x", type: "Db" },
    ]);
  });

  it("drops a name declared with two different types", () => {
    expect(locals("final r = PgRepo();", "final r = MemRepo();", "final s = PgRepo();")).toEqual([{ name: "s", type: "PgRepo" }]);
  });

  it("does not type a local whose initializer wraps onto a chain below", () => {
    expect(locals("final handler = const Pipeline()", "    .addMiddleware(logRequests())", "    .addHandler(router);")).toEqual([]);
  });

  it("reads each statement of a line, past a trailing comment", () => {
    expect(locals("final a = PgRepo(); final UserRepo b = getIt<UserRepo>(); // two", "for (var i = 0; i < n; i++) {")).toEqual([
      { name: "a", type: "PgRepo" },
      { name: "b", type: "UserRepo" },
    ]);
  });

  it("types a Riverpod read with the provider's declared type when the provider is in the file", () => {
    const src = [
      "final repoProvider = Provider<UserRepo>((ref) => PgRepo());",
      "class C {",
      "  final Ref ref;",
      "  C(this.ref);",
      "  Future<void> run() async {",
      "    final repo = ref.read(repoProvider);",
      "    await ref.watch(repoProvider).save(u);",
      "  }",
      "}",
    ].join("\n");
    const [c] = classes(src);
    const run = c!.methods.find((m) => m.name === "run")!;
    expect(run.localTypes).toEqual([{ name: "repo", type: "UserRepo", qualifier: "repoProvider" }]);
    expect(run.calls.find((x) => x.receiverQualifier)).toMatchObject({ receiverType: "UserRepo", receiverQualifier: "repoProvider" });
  });
});

describe("dart lookups chained into a call", () => {
  it("types the receiver of a locator lookup", () => {
    expect(calls("await getIt<UserRepo>().find(id);").find((c) => c.receiverType)).toMatchObject({
      name: "getIt<UserRepo>().find",
      receiverType: "UserRepo",
    });
    expect(calls("await sl.get<UserRepo>(instanceName: 'mem').load(id);").find((c) => c.receiverType)).toMatchObject({
      receiverType: "UserRepo",
      receiverQualifier: "mem",
    });
    expect(calls("context.watch<UserRepo>().save(u);").find((c) => c.receiverType)).toMatchObject({ receiverType: "UserRepo" });
    expect(calls("ref.read(repoProvider).save(u);").find((c) => c.receiverQualifier)).toMatchObject({ receiverQualifier: "repoProvider" });
  });

  it("records a plain generic call by its type argument, and never a comparison", () => {
    expect(calls("final r = context.read<UserRepo>();").map((c) => c.name)).toContain("context.read<UserRepo>");
    expect(calls("if (i<n && x>(y)) {}").some((c) => c.name.includes("<"))).toBe(false);
  });

  it("gives an untyped receiver no type", () => {
    expect(calls("await repo.find(id);").every((c) => !c.receiverType && !c.receiverQualifier)).toBe(true);
  });
});

describe("dart container registrations", () => {
  it("reads get_it, kiwi and GetX registrations", () => {
    expect(
      bindings(
        [
          "getIt.registerSingleton<UserRepo>(PgRepo());",
          "getIt.registerLazySingleton<UserRepo>(() => PgRepo(), instanceName: 'pg');",
          "sl.registerFactory<UserRepo>(() => MemRepo(), instanceName: 'mem');",
          "locator",
          "  ..registerFactory<Cache>(MemCache.new)",
          "  ..registerSingletonAsync<Db>(() async {",
          "    return SqlDb();",
          "  });",
          "kiwi.registerFactory<Clock>((c) => FakeClock(), name: 'fake');",
          "Get.lazyPut<Mailer>(() => SmtpMailer(), tag: 'smtp');",
          "Get.put<Auth>(FirebaseAuthImpl());",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "registerSingleton" },
      { service: "UserRepo", implementation: "PgRepo", via: "registerLazySingleton", qualifier: "pg", keyedOnly: true },
      { service: "UserRepo", implementation: "MemRepo", via: "registerFactory", qualifier: "mem", keyedOnly: true },
      { service: "Cache", implementation: "MemCache", via: "registerFactory" },
      { service: "Db", implementation: "SqlDb", via: "registerSingletonAsync" },
      { service: "Clock", implementation: "FakeClock", via: "registerFactory", qualifier: "fake", keyedOnly: true },
      { service: "Mailer", implementation: "SmtpMailer", via: "Get.lazyPut", qualifier: "smtp", keyedOnly: true },
      { service: "Auth", implementation: "FirebaseAuthImpl", via: "Get.put" },
    ]);
  });

  it("emits nothing for a self registration or a factory that is not one construction", () => {
    expect(
      bindings(
        [
          "getIt.registerLazySingleton<UserService>(() => UserService(getIt<UserRepo>()));",
          "getIt.registerSingleton(PgRepo());",
          "getIt.registerSingletonAsync<Prefs>(() => SharedPreferences.getInstance());",
          "getIt.registerLazySingleton<UserRepo>(() {",
          "  final r = PgRepo();",
          "  return r;",
          "});",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("emits both of two unconditional registrations", () => {
    expect(bindings(["getIt.registerSingleton<UserRepo>(PgRepo());", "getIt.registerSingleton<UserRepo>(MemRepo());"].join("\n")).map((b) => b.implementation)).toEqual([
      "PgRepo",
      "MemRepo",
    ]);
  });

  it("reads injectable annotations, environment-specific ones included", () => {
    expect(
      bindings(
        [
          "@LazySingleton(as: UserRepo)",
          "class PgRepo implements UserRepo {}",
          "",
          "/// In tests.",
          "@Injectable(",
          "  as: UserRepo,",
          "  env: [Environment.test],",
          ")",
          "class MemRepo implements UserRepo {}",
          "",
          "@Named('redis')",
          "@Singleton(as: Cache)",
          "class RedisCache implements Cache {}",
          "",
          "@injectable",
          "class UserService {}",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "@LazySingleton" },
      { service: "UserRepo", implementation: "MemRepo", via: "@Injectable" },
      { service: "Cache", implementation: "RedisCache", via: "@Singleton", qualifier: "redis", keyedOnly: true },
    ]);
  });

  it("reads injectable's generated config and module members", () => {
    expect(
      bindings(
        [
          "gh.lazySingleton<UserRepo>(() => PgRepo(gh<Db>()));",
          "gh.factory<Cache>(() => MemCache(), instanceName: 'mem');",
          "@module",
          "abstract class RegisterModule {",
          "  @LazySingleton(as: Mailer)",
          "  SmtpMailer get mailer => SmtpMailer();",
          "  @injectable",
          "  Clock clock() => FakeClock();",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "gh.lazySingleton" },
      { service: "Cache", implementation: "MemCache", via: "gh.factory", qualifier: "mem", keyedOnly: true },
      { service: "Mailer", implementation: "SmtpMailer", via: "@module" },
      { service: "Clock", implementation: "FakeClock", via: "@module" },
    ]);
  });

  it("reads provider widgets and Riverpod providers, overrides included", () => {
    expect(
      bindings(
        [
          "Provider<UserRepo>(create: (_) => PgRepo()),",
          "Provider<Cache>.value(value: MemCache()),",
          "RepositoryProvider<Auth>(",
          "  create: (context) => FirebaseAuthImpl(),",
          "),",
          "BlocProvider<UserBloc>(create: (_) => UserBloc()),",
          "final repoProvider = Provider<UserRepo>((ref) => PgRepo());",
          "final cacheProvider = Provider.autoDispose.family<Cache, int>((ref, id) {",
          "  return MemCache();",
          "});",
          "@riverpod",
          "Mailer mailer(MailerRef ref) => SmtpMailer();",
          "overrides: [repoProvider.overrideWithValue(MemRepo())],",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "Provider" },
      { service: "Cache", implementation: "MemCache", via: "Provider" },
      { service: "Auth", implementation: "FirebaseAuthImpl", via: "RepositoryProvider" },
      { service: "repoProvider", implementation: "PgRepo", via: "Provider", keyedOnly: true },
      { service: "cacheProvider", implementation: "MemCache", via: "Provider", keyedOnly: true },
      { service: "mailerProvider", implementation: "SmtpMailer", via: "@riverpod", keyedOnly: true },
      { service: "repoProvider", implementation: "MemRepo", via: "overrideWithValue", keyedOnly: true },
    ]);
  });
});
