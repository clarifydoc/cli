import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

async function methodOf(src: string, lang: "java" | "kotlin", name: string): Promise<FunctionInfo> {
  const tree = await parseSource(src, lang as any, lang === "java" ? "X.java" : "X.kt");
  const ex = new JavaKotlinExtractor();
  const all = [...ex.extractFunctions(tree, src), ...ex.extractClasses(tree, src).flatMap((c) => c.methods)];
  const m = all.find((f) => f.name === name);
  if (!m) throw new Error(`no ${name}`);
  return m;
}

function receivers(calls: CallInfo[]): Record<string, string | undefined> {
  return Object.fromEntries(
    calls.map((c) => [c.name, c.receiverType ? `${c.receiverType}${c.receiverQualifier ? `#${c.receiverQualifier}` : ""}` : undefined]),
  );
}

describe("JVM argsOf — what a CRUD call is handed", () => {
  it("keeps the one variable handed to a write-named method on an object, nothing else", async () => {
    const m = await methodOf(`class C {
  void m(Club club) {
    change.create(club);
    change.saveOrUpdate(club);
    clubs.add(club);
    cache.get(key);
    create(club);
    change.update(club.getId());
  }
}`, "java", "m");
    expect(m.calls.filter((c) => c.args).map((c) => `${c.name}(${c.args!.join(",")})`)).toEqual(["change.create(club)", "change.saveOrUpdate(club)"]);
  });
});

describe("JVM receiverTypeOf — client proxies built in the chain", () => {
  it("types a JAX-RS, MicroProfile, Feign or Retrofit proxy by the interface it is built for", async () => {
    const m = await methodOf(`class C {
  void m() {
    JAXRSClientFactory.fromClient(client, PlayerApi.class, true).getPlayer(id);
    JAXRSClientFactory.create(url, com.example.league.ClubApi.class).listClubs();
    RestClientBuilder.newBuilder().baseUri(uri).build(KitApi.class).listKits();
    Feign.builder().decoder(d).target(FixtureApi.class, url).nextFixture();
    retrofit.create(InjuryApi.class).latest();
    factory.create(Player.class).getName();
  }
}`, "java", "m");
    expect(m.calls.filter((c) => c.receiverType).map((c) => c.receiverType)).toEqual([
      "PlayerApi", "com.example.league.ClubApi", "KitApi", "FixtureApi", "InjuryApi",
    ]);
  });
});

describe("JVM receiverTypeOf — container lookups chained into a call", () => {
  it("types Java getBean / getInstance / cast receivers, never a construction", async () => {
    const m = await methodOf(`class C {
  void m() {
    ctx.getBean(ReportBuilder.class).build();
    injector.getInstance(Key.get(Sorter.class, Names.named("fast"))).sortAll(null);
    ((Notifier) ctx.getBean("mailNotifier")).notifyPlayer("u");
    new Foo().bar();
    repo.find(1).getId();
  }
}`, "java", "m");
    expect(receivers(m.calls)).toMatchObject({
      "ctx.getBean(ReportBuilder.class).build": "ReportBuilder",
      "new Foo().bar": undefined,
    });
    const sort = m.calls.find((c) => c.name.endsWith(".sortAll"));
    expect([sort?.receiverType, sort?.receiverQualifier]).toEqual(["Sorter", "fast"]);
    const notify = m.calls.find((c) => c.name.endsWith(".notifyPlayer"));
    expect([notify?.receiverType, notify?.receiverQualifier]).toEqual(["Notifier", "mailNotifier"]);
    expect(m.calls.find((c) => c.name.endsWith(".getId"))?.receiverType).toBeUndefined();
  });

  it("types Kotlin getBean / Koin get<T>() receivers, keeping a held-noise leaf (`find`) on a typed receiver", async () => {
    const m = await methodOf(`package x
class C {
  fun m() {
    ctx.getBean(CarRepo::class.java).loadAll()
    get<KRepo>(named("main")).find(1)
    getBean<Exporter>().export("d")
    CarRepo().loadAll()
  }
}`, "kotlin", "m");
    const by = (leaf: string) => m.calls.find((c) => c.name.endsWith(`.${leaf}`) && c.name.includes("("));
    expect([by("loadAll")?.receiverType]).toEqual(["CarRepo"]);
    expect([by("find")?.receiverType, by("find")?.receiverQualifier]).toEqual(["KRepo", "main"]);
    expect(by("export")?.receiverType).toBe("Exporter");
    expect(m.calls.find((c) => c.name === "CarRepo().loadAll")?.receiverType).toBeUndefined();
  });
});

describe("JVM call attribution through lambdas", () => {
  it("attributes a Java lambda argument's calls to the enclosing method", async () => {
    const m = await methodOf(`class C {
  void m() {
    cars.forEach(o -> repo.save(o));
    list.stream().map(x -> mapper.toDto(x)).count();
  }
}`, "java", "m");
    const names = m.calls.map((c) => c.name);
    expect(names).toContain("repo.save");
    expect(names).toContain("mapper.toDto");
  });

  it("attributes a Kotlin trailing lambda's calls to the enclosing function", async () => {
    const m = await methodOf(`package x
class C {
  fun m() {
    list.forEach { repo.store(it) }
    run(fun() { audit.record() })
  }
}`, "kotlin", "m");
    const names = m.calls.map((c) => c.name);
    expect(names).toContain("repo.store");
    expect(names).toContain("audit.record");
  });
});

describe("Kotlin extension functions", () => {
  it("reports the receiver as an implicit first parameter", async () => {
    const f = await methodOf(`package x
fun Band.addRow(r: Row) { this.rows.add(r) }`, "kotlin", "addRow");
    expect(f.params).toEqual([
      { name: "this", type: "Band", defaultValue: null, isReceiver: true },
      { name: "r", type: "Row", defaultValue: null },
    ]);
    const plain = await methodOf(`package x
fun plain(r: Row) {}`, "kotlin", "plain");
    expect(plain.params.some((p) => p.isReceiver)).toBe(false);
  });
});

describe("Java method references", () => {
  it("records `gameService::updateGame`, `GameVo::from` and `Snapshot::new` as calls", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { extractFunctions } = await import("../../functions-classes/index.js");
    const { extractClasses } = await import("../../functions-classes/index.js");
    const src = `class GameEndpoint {
  Mono<ServerResponse> updateGame(ServerRequest request) {
    return request.bodyToMono(GameRequest.class)
      .flatMap(gameService::updateGame)
      .map(GameVo::from)
      .map(Snapshot::new)
      .flatMap(this::toResponse);
  }
}`;
    const tree = await parseSource(src, "java" as never, "GameEndpoint.java");
    void extractFunctions;
    const [cls] = extractClasses(tree, src, "java" as never);
    const calls = cls!.methods[0]!.calls.map((c) => c.name);
    expect(calls).toEqual(expect.arrayContaining(["gameService.updateGame", "GameVo.from", "Snapshot", "this.toResponse"]));
  });
});
