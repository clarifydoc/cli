import { describe, it, expect } from "vitest";
import { extractCallsFromBody, extractFunctionsWithSpec } from "../shared/regex-base.js";
import { scalaSpec } from "./index.js";
import { extractScalaDiBindings, extractScalaLocalTypes } from "./di.js";

const classes = (src: string) => scalaSpec.extractClasses!(src.split("\n"), []);
const props = (src: string) => classes(src)[0]!.properties.map((p) => [p.name, p.type, p.visibility, p.qualifier]);
const bindings = (src: string) =>
  extractScalaDiBindings(src.split("\n")).map((b) => {
    const { line: _line, ...rest } = b;
    return rest;
  });
const locals = (...body: string[]) => extractScalaLocalTypes(body, { name: "f" });
const calls = (line: string) => extractCallsFromBody([line], 0, 1, ["//"], scalaSpec.callPatterns);

describe("scala traits", () => {
  it("makes a trait an interface whose abstract defs carry no calls", () => {
    const [t] = classes(["trait PayGw {", "  def charge(cents: Long): Unit", "  def refund(id: String): Option[Long]", "}"].join("\n"));
    expect(t!.kind).toBe("interface");
    expect(t!.methods.map((m) => [m.name, m.calls.length])).toEqual([
      ["charge", 0],
      ["refund", 0],
    ]);
  });
});

describe("scala constructor members", () => {
  const ctor = (src: string) => {
    const [cls] = classes(src);
    return cls!.methods.find((m) => m.name === cls!.name);
  };
  const params = (src: string) => ctor(src)?.params.map((p) => [p.name, p.type, p.qualifier]);

  it("reads every parameter of an `@Inject()` constructor, keyed by `@Named`, without the implicit list", () => {
    const src = "class CarSvc @Inject()(repo: CarRepo, @Named(\"stripe\") gw: PayGw)(implicit ec: ExecutionContext) {\n}";
    expect(params(src)).toEqual([
      ["repo", "CarRepo", undefined],
      ["gw", "PayGw", "stripe"],
    ]);
    expect(ctor(src)).toMatchObject({ line: 1, endLine: 1, calls: [] });
    // A plain parameter is no field: the field list stays the language's.
    expect(props(src)).toEqual([]);
  });

  it("reads a spaced `@Inject() (val …)` list, an access-modified one and a wrapped one", () => {
    expect(props("class ValSvc @Inject() (val repo: CarRepo, private val audit: Auditable) {\n}")).toEqual([
      ["repo", "CarRepo", "public", undefined],
      ["audit", "Auditable", "private", undefined],
    ]);
    expect(ctor("class ValSvc @Inject() (val repo: CarRepo) {\n}")).toBeUndefined();
    expect(params("class Quiet private[app] (ec: ExecutionContext) {\n}")).toEqual([["ec", "ExecutionContext", undefined]]);
    expect(
      params(["class Ctrl @Inject()(", "    cc: ControllerComponents,", "    service: CarService", ")(implicit ec: ExecutionContext)", "    extends AbstractController(cc) {", "}"].join("\n")),
    ).toEqual([
      ["cc", "ControllerComponents", undefined],
      ["service", "CarService", undefined],
    ]);
  });

  it("keeps a case class's fields public and adds no constructor", () => {
    expect(props("case class Car(id: Long, note: Option[String] = None)")).toEqual([
      ["id", "Long", "public", undefined],
      ["note", "Option[String]", "public", undefined],
    ]);
    expect(ctor("case class Car(id: Long)")).toBeUndefined();
  });
});

describe("scala fields", () => {
  it("reads annotated one-line fields and their key", () => {
    expect(
      props(
        [
          "class FieldSvc {",
          "  @Inject var fieldRepo: CarRepo = _",
          "  @Inject @Named(\"mem\") var mem: Repo = _",
          "  @Named(\"pg\")",
          "  @Inject var pg: Repo = _",
          "  private lazy val cache: Cache = new MemCache()",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      ["fieldRepo", "CarRepo", "public", undefined],
      ["mem", "Repo", "public", "mem"],
      ["pg", "Repo", "public", "pg"],
      ["cache", "Cache", "private", undefined],
    ]);
  });

  it("types an unannotated field from a construction or lookup, but not a method local", () => {
    expect(
      props(
        [
          "class Svc(injector: Injector) {",
          "  private val repo = new PgRepo(db)",
          "  lazy val wired = wire[MemRepo]",
          "  val looked = injector.instanceOf[Cache]",
          "  val n = 3",
          "  val client = new Builder()",
          "    .build()",
          "  val built = Repo(1)",
          "  def f(): Unit = {",
          "    val local = new PgRepo(db)",
          "  }",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      ["repo", "PgRepo", "private", undefined],
      ["wired", "MemRepo", "public", undefined],
      ["looked", "Cache", "public", undefined],
    ]);
  });

  it("drops initializer-typed members of a braceless (Scala 3) class", () => {
    expect(props(["class Svc:", "  def f(): Unit =", "    val local = new PgRepo(db)", "    local.find(1)"].join("\n"))).toEqual([]);
  });
});

describe("scala locals", () => {
  it("types locals from annotations, constructions and injector lookups", () => {
    expect(
      locals(
        "val local: CarRepo = injector.instanceOf[CarRepo]",
        "val r = injector.instanceOf[Repo]",
        "val c = injector.instanceOf(classOf[Cache])",
        "val g = injector.getInstance(classOf[Clock])",
        "val k = injector.getInstance(Key.get(classOf[Repo], Names.named(\"mem\")))",
        "val n = new MemRepo()",
        "val a = new Runnable {",
        "val w = wire[PgRepo]",
        "val x = compute()",
        "val y = Repo(1)",
      ),
    ).toEqual([
      { name: "local", type: "CarRepo" },
      { name: "r", type: "Repo" },
      { name: "c", type: "Cache" },
      { name: "g", type: "Clock" },
      { name: "k", type: "Repo", qualifier: "mem" },
      { name: "n", type: "MemRepo" },
      { name: "a", type: "Runnable" },
      { name: "w", type: "PgRepo" },
    ]);
  });

  it("drops a name declared with two different types", () => {
    expect(locals("val x = new PgRepo(a)", "val x = new MemRepo()")).toEqual([]);
  });

  it("does not type a local whose initializer wraps onto a chain below", () => {
    expect(locals("val client = new Builder()", "  .withTimeout(3)", "  .build()")).toEqual([]);
  });

  it("attaches locals to a one-line method", () => {
    const [fn] = extractFunctionsWithSpec(["def f(): Unit = { val r = injector.instanceOf[Repo]; r.find(1) } // r"], scalaSpec);
    expect(fn!.localTypes).toEqual([{ name: "r", type: "Repo" }]);
  });
});

describe("scala lookups chained into a call", () => {
  it("types the receiver of an injector lookup", () => {
    expect(calls("injector.instanceOf[CarRepo].loadAll()")[0]).toMatchObject({ name: "injector.instanceOf[CarRepo].loadAll", receiverType: "CarRepo" });
    expect(calls("injector.instanceOf(classOf[CarRepo]).loadAll()")[0]).toMatchObject({ receiverType: "CarRepo" });
    expect(calls("injector.getInstance(classOf[Repo]).find(1)")[0]).toMatchObject({ receiverType: "Repo" });
  });

  it("gives an untyped receiver no type", () => {
    expect(calls("repo.loadAll()").every((c) => !c.receiverType)).toBe(true);
  });
});

describe("scala container registrations", () => {
  it("reads Guice bindings, keyed ones keyed only", () => {
    expect(
      bindings(
        [
          "bind(classOf[Pricing]).to(classOf[DiscountPricing])",
          "bind(classOf[PayGw]).annotatedWith(Names.named(\"stripe\")).to(classOf[StripeGw])",
          "bind(classOf[Clock])",
          "  .toInstance(new FixedClock(0L))",
          "bind(classOf[Repo]).toProvider(classOf[RepoProvider])",
          "bind(classOf[Worker]).asEagerSingleton()",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "Pricing", implementation: "DiscountPricing", via: "bind" },
      { service: "PayGw", implementation: "StripeGw", via: "bind", qualifier: "stripe", keyedOnly: true },
      { service: "Clock", implementation: "FixedClock", via: "bind" },
    ]);
  });

  it("reads Play / scala-guice bindings and emits both of two unconditional ones", () => {
    expect(
      bindings(
        [
          "Seq(",
          "  bind[Repo].to[PgRepo],",
          "  bind[Repo].qualifiedWith(\"mem\").to[MemRepo],",
          "  bind[Cache].annotatedWithName(\"redis\").to[RedisCache].in[Singleton],",
          "  bind[Repo].to[OtherRepo]",
          ")",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "Repo", implementation: "PgRepo", via: "bind" },
      { service: "Repo", implementation: "MemRepo", via: "bind", qualifier: "mem", keyedOnly: true },
      { service: "Cache", implementation: "RedisCache", via: "bind", qualifier: "redis", keyedOnly: true },
      { service: "Repo", implementation: "OtherRepo", via: "bind" },
    ]);
  });

  it("reads @ImplementedBy as a default, @Provides methods and MacWire", () => {
    expect(
      bindings(
        [
          "@ImplementedBy(classOf[MemCache])",
          "trait Cache {",
          "}",
          "class M extends AbstractModule {",
          "  @Provides",
          "  @Named(\"ses\")",
          "  def ses(): Mailer = new SesMailer()",
          "  @Provides def smtp(conf: Conf): Mailer = new SmtpMailer(conf)",
          "  @Provides def helper(): Mailer = makeMailer()",
          "}",
          "trait Wiring {",
          "  lazy val repo: Repo = wire[PgRepo]",
          "  lazy val svc = wire[Svc]",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "Cache", implementation: "MemCache", via: "@ImplementedBy", ifAbsent: true },
      { service: "Mailer", implementation: "SesMailer", via: "@Provides", qualifier: "ses", keyedOnly: true },
      { service: "Mailer", implementation: "SmtpMailer", via: "@Provides" },
      { service: "Repo", implementation: "PgRepo", via: "wire" },
    ]);
  });
});
