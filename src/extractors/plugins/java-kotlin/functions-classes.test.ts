import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";

async function classesOf(src: string, lang: "java" | "kotlin"): Promise<ClassInfo[]> {
  const tree = await parseSource(src, lang as any, lang === "java" ? "X.java" : "X.kt");
  return new JavaKotlinExtractor().extractClasses(tree, src);
}

function method(cls: ClassInfo | undefined, name: string): FunctionInfo {
  const m = cls?.methods.find((x) => x.name === name);
  if (!m) throw new Error(`no method ${name}`);
  return m;
}

/**
 * `FunctionInfo.localTypes` — declared-type locals of a method body. The
 * symbol linker uses these to resolve calls through typed locals (Strategy 2)
 * and to veto unique-name guesses whose receiver's declared type contradicts
 * the target (Strategy 7).
 */
describe("Java/Kotlin localTypes extraction", () => {
  it("captures Java typed locals and enhanced-for variables, skipping String; an untyped var keeps its initializer call", async () => {
    const src = `package x;
class ClubApiImpl {
  void update(String id) {
    Club existing = repo.find(id);
    var inferred = other();
    String name = existing.getName();
    List<Grant> grants = existing.getGrants();
    for (Grant g : grants) { g.touch(); }
  }
}`;
    const classes = await classesOf(src, "java");
    const locals = classes[0]!.methods[0]!.localTypes ?? [];
    const byName = Object.fromEntries(locals.map((l) => [l.name, l.type]));
    expect(byName["existing"]).toBe("Club");
    expect(byName["grants"]).toBe("List");
    expect(byName["g"]).toBe("Grant");
    // No stated type: the linker types it by what `other()` is declared to return.
    expect(locals.find((l) => l.name === "inferred")).toEqual({ name: "inferred", type: "", from: "other()" });
    expect(byName["name"]).toBeUndefined();
  });

  it("captures Kotlin explicitly-typed locals, and keeps the call an initializer that states nothing makes", async () => {
    const src = `package x
class Service {
  fun m(id: Int) {
    val doc: Document = dao.get(id)
    val inferred = dao.other()
  }
}`;
    const classes = await classesOf(src, "kotlin");
    const locals = classes[0]!.methods.find((m) => m.name === "m")!.localTypes ?? [];
    expect(locals).toEqual([{ name: "doc", type: "Document" }, { name: "inferred", type: "", from: "dao.other()" }]);
  });

  it("infers a Java `var` local from a construction, a container lookup or a cast — with the lookup's key", async () => {
    const src = `class C {
  void m() {
    var made = new ReportBuilder<String>();
    var bean = ctx.getBean(ReportBuilder.class);
    var named = ctx.getBean("fastCache", Cache.class);
    var cast = (Notifier) ctx.getBean("mailNotifier");
    var guice = injector.getInstance(Pricing.class);
    var keyed = injector.getInstance(Key.get(Sorter.class, Names.named("fast")));
    Sorter typed = injector.getInstance(Key.get(Sorter.class, Names.named("slow")));
    var unknown = factory.create();
    var single = Foo.getInstance();
  }
}`;
    const locals = (await classesOf(src, "java"))[0]!.methods[0]!.localTypes;
    expect(locals).toEqual([
      { name: "made", type: "ReportBuilder" },
      { name: "bean", type: "ReportBuilder" },
      { name: "named", type: "Cache", qualifier: "fastCache" },
      { name: "cast", type: "Notifier", qualifier: "mailNotifier" },
      { name: "guice", type: "Pricing" },
      { name: "keyed", type: "Sorter", qualifier: "fast" },
      { name: "typed", type: "Sorter", qualifier: "slow" },
      { name: "unknown", type: "", from: "factory.create()" },
      { name: "single", type: "", from: "Foo.getInstance()" },
    ]);
  });

  it("infers an untyped Kotlin `val` from a construction, getBean, Koin get<T>() and a cast", async () => {
    const src = `package x
fun Text(s: String) {}
class C {
  fun m() {
    val made = CarRepo()
    val qualified = com.acme.CarRepo(1)
    val applied = CarRepo().apply { init() }
    val bean = ctx.getBean(CarRepo::class.java)
    val named = ctx.getBean("s3", Storage::class.java)
    val koin = get<KRepo>()
    val koinNamed = get<Mailer>(named("noop"))
    val typedKoin: Mailer = get(named("smtp"))
    val cast = ctx.getBean("x") as Exporter
    val delegated by inject<Clock>(named("utc"))
    val lazyLocal by lazy { Cache() }
    val composable = Text("hi")
    val list = listOf(1)
    val lower = repo.find(1)
  }
}`;
    const locals = (await classesOf(src, "kotlin"))[0]!.methods.find((m) => m.name === "m")!.localTypes;
    expect(locals).toEqual([
      { name: "made", type: "CarRepo" },
      { name: "qualified", type: "CarRepo" },
      { name: "applied", type: "CarRepo" },
      { name: "bean", type: "CarRepo" },
      { name: "named", type: "Storage", qualifier: "s3" },
      { name: "koin", type: "KRepo" },
      { name: "koinNamed", type: "Mailer", qualifier: "noop" },
      { name: "typedKoin", type: "Mailer", qualifier: "smtp" },
      { name: "cast", type: "Exporter", qualifier: "x" },
      { name: "delegated", type: "Clock", qualifier: "utc" },
      { name: "lazyLocal", type: "Cache" },
      // No stated type: typed later by what each call is declared to return.
      { name: "composable", type: "", from: "Text()" },
      { name: "list", type: "", from: "listOf()" },
      { name: "lower", type: "", from: "repo.find()" },
    ]);
  });
});

describe("Java/Kotlin supertypes", () => {
  it("lists each implemented interface once, and keeps the superclass as a bare name", async () => {
    const [cls] = await classesOf(`class A<T> extends Base<T> implements Auditable, com.x.Closeable2<T> {}`, "java");
    expect(cls!.extends).toBe("Base");
    expect(cls!.implements).toEqual(["Auditable", "com.x.Closeable2<T>"]);
  });

  it("reads Java interface inheritance: first super-interface in extends, the rest in implements", async () => {
    const [iface] = await classesOf(`interface I extends J, K<T> { void x(); }`, "java");
    expect(iface!.kind).toBe("interface");
    expect(iface!.extends).toBe("J");
    expect(iface!.implements).toEqual(["K<T>"]);
  });

  it("reads Kotlin supertypes, including an explicit delegation (`I by impl`)", async () => {
    const classes = await classesOf(`package x
class X : Base(), I by impl, com.x.J<T> {}
interface Y : A, B`, "kotlin");
    expect(classes[0]!.extends).toBe("Base");
    expect(classes[0]!.implements).toEqual(["I", "com.x.J"]);
    expect(classes[1]!.extends).toBe("A");
    expect(classes[1]!.implements).toEqual(["B"]);
  });
});

describe("Java/Kotlin injection points", () => {
  it("reads Java parameter and field qualifiers (@Qualifier, @Named, @Resource(name))", async () => {
    const [cls] = await classesOf(`class A {
  @Autowired @Qualifier("disk") private Storage storage;
  @Resource(name = "r") Repo r;
  @Resource Repo byName;
  @Inject @Named Billing billing;
  @Inject @Fast Sorter sorter;
  @Autowired @Lazy Clock clock;
  @JsonProperty("x") Dto dto;
  A(@Qualifier("xmlEncoder") Encoder encoder, @Named("n") final Foo f, Bar plain) { }
}`, "java");
    const q = Object.fromEntries(cls!.properties.map((p) => [p.name, p.qualifier]));
    expect(q).toEqual({
      storage: "disk", r: "r", byName: undefined, billing: "billing", sorter: "Fast", clock: undefined, dto: undefined,
    });
    expect(method(cls, "A").params.map((p) => p.qualifier)).toEqual(["xmlEncoder", "n", undefined]);
  });

  it("gives a field copied from a qualified constructor parameter the parameter's key", async () => {
    const [cls] = await classesOf(`class CaseCache {
  private final Cache fastCache;
  private final Cache other;
  @Named("own") private final Cache own;
  CaseCache(Cache fastCache, @Qualifier("fastCache") Cache other, @Qualifier("x") Cache own) {
    this.fastCache = fastCache; this.other = other; this.own = own;
  }
}`, "java");
    const q = Object.fromEntries(cls!.properties.map((p) => [p.name, p.qualifier]));
    expect(q).toEqual({ fastCache: undefined, other: "fastCache", own: "own" });
  });

  it("treats a custom annotation as a qualifier only on an explicit @Inject point", async () => {
    const [cls] = await classesOf(`class C {
  @Inject C(@Fast Sorter a, @Nullable Repo b) {}
  void plain(@Fast Sorter s) {}
}`, "java");
    expect(method(cls, "C").params.map((p) => p.qualifier)).toEqual(["Fast", undefined]);
    expect(method(cls, "plain").params[0]!.qualifier).toBeUndefined();
  });

  it("reads Kotlin parameter annotations (sibling parameter_modifiers), use-site targets and nullable types", async () => {
    const [cls] = await classesOf(`package x
class C {
  fun f(@Named("p") r: CarRepo?, s: Repo, @get:Named("g") t: Repo): Foo? = null
  fun g(): List<Foo> { return emptyList() }
  fun Foo.ext(): Bar = Bar()
  fun unit() {}
}`, "kotlin");
    const f = method(cls, "f");
    expect(f.params).toEqual([
      { name: "r", type: "CarRepo?", defaultValue: null, qualifier: "p" },
      { name: "s", type: "Repo", defaultValue: null },
      { name: "t", type: "Repo", defaultValue: null },
    ]);
    expect(f.returnType).toBe("Foo?");
    expect(method(cls, "g").returnType).toBe("List<Foo>");
    expect(method(cls, "ext").returnType).toBe("Bar");
    expect(method(cls, "unit").returnType).toBeNull();
  });

  it("emits the Kotlin primary constructor with ALL its parameters, and types properties from them", async () => {
    const [cls] = await classesOf(`package x
@Service
class CarSvc(
    @Qualifier("s3") private val storage: Storage,
    @field:Named("a") val a: A,
    plainRepo: CarRepo,
    @Named("p") qualifiedPlain: Repo?,
    count: Int = 3,
) {
    private val keptRepo = plainRepo
    private val keptQualified = qualifiedPlain
    private val made = Cache()
    private val untypedRepo by inject<KRepo>()
    private val namedRepo: KRepo by inject(named("k"))
    private val lazyRepo by lazy { CarRepo() }
    @Inject @Named("q") lateinit var b: B
    private val unknown = compute()
}`, "kotlin");
    const ctor = method(cls, "constructor");
    expect(ctor.params).toEqual([
      { name: "storage", type: "Storage", defaultValue: null, qualifier: "s3" },
      { name: "a", type: "A", defaultValue: null, qualifier: "a" },
      { name: "plainRepo", type: "CarRepo", defaultValue: null },
      { name: "qualifiedPlain", type: "Repo?", defaultValue: null, qualifier: "p" },
      { name: "count", type: "Int", defaultValue: "3" },
    ]);
    const props = Object.fromEntries(cls!.properties.map((p) => [p.name, [p.type, p.qualifier]]));
    expect(props).toEqual({
      keptRepo: ["CarRepo", undefined],
      keptQualified: ["Repo?", "p"],
      made: ["Cache", undefined],
      untypedRepo: ["KRepo", undefined],
      namedRepo: ["KRepo", "k"],
      lazyRepo: ["CarRepo", undefined],
      b: ["B", "q"],
      unknown: [null, undefined],
      storage: ["Storage", "s3"],
      a: ["A", "a"],
    });
  });

  it("marks every parameter of an @Inject primary constructor as an explicit point", async () => {
    const [cls] = await classesOf(`package x
class Vm @Inject constructor(@Fast private val s: Sorter, @ApplicationContext ctx: Context)`, "kotlin");
    const ctor = method(cls, "constructor");
    expect(ctor.decorators).toEqual(["Inject"]);
    expect(ctor.params.map((p) => p.qualifier)).toEqual(["Fast", "ApplicationContext"]);
  });

  it("emits no constructor method for a class without primary-constructor parameters", async () => {
    const classes = await classesOf(`package x
class A
class B()
class C @Inject constructor()`, "kotlin");
    for (const c of classes) expect(c.methods.some((m) => m.name === "constructor")).toBe(false);
  });
});

describe("nested types and aliases", () => {
  it("extracts Java nested classes with their own methods", async () => {
    const classes = await classesOf(`
package a;
public class Car {
  public static class Builder { public Car build() { return new Car(); } }
  @Nested class WhenEmpty { void rejects() {} }
  enum Status { OPEN, CLOSED }
}`, "java");
    expect(classes.map((c) => `${c.name}[${c.methods.map((m) => m.name)}]`)).toEqual(["Car[]", "Builder[build]", "WhenEmpty[rejects]", "Status[]"]);
  });

  it("extracts Kotlin nested classes, keeps objects folded into their class, and reads a typealias as the class it names", async () => {
    const classes = await classesOf(`
package a
class Outer {
  class Inner { fun go() = 1 }
  companion object { fun make() = Outer() }
}
typealias Players = PlayerRepository
private typealias Handler<T> = (T) -> Unit
`, "kotlin");
    expect(classes.map((c) => `${c.name}[${c.methods.map((m) => m.name)}]`)).toEqual(["Outer[make]", "Inner[go]", "Players[]"]);
    const alias = classes.find((c) => c.name === "Players")!;
    expect([alias.extends, alias.decorators]).toEqual(["PlayerRepository", ["typealias"]]);
  });
});

describe("Java visibility from the declaration's own modifiers", () => {
  it("keeps a public class with private members public (real-repo FP: half the public types unexported)", async () => {
    const classes = await classesOf(`package x;
@Entity
public class Club {
  private String name;
  protected int founded;
  public String getName() { String note = "private "; return name; }
  private void rename() {}
}
class Garage {
  public void park() {}
}`, "java");
    const club = classes.find((c) => c.name === "Club")!;
    expect(club.isExported).toBe(true);
    expect(method(club, "getName").isExported).toBe(true);
    expect(method(club, "rename").isExported).toBe(false);
    expect(method(classes.find((c) => c.name === "Garage"), "park").isExported).toBe(true);
  });
});
