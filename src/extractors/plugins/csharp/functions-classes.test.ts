import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import type { ClassInfo } from "../../functions-classes/base.js";

async function classesOf(src: string): Promise<ClassInfo[]> {
  const tree = await parseSource(src, "csharp" as any, "C.cs");
  return extractClasses(tree, src, "csharp");
}

describe("C# functions-classes — record/struct extraction", () => {
  it("captures `record` (CQRS command/query) types as classes with their base", async () => {
    const SRC = `namespace X;
public record GetRoleHoldersQuery(Guid RoleId, int Page = 1) : IRequest<int>;
public record CreateOwnerCommand(string Name) : IRequest<Guid>;`;
    const classes = await classesOf(SRC);
    const names = classes.map((c) => c.name);
    expect(names).toContain("GetRoleHoldersQuery");
    expect(names).toContain("CreateOwnerCommand");
    // The MediatR base must be captured so the dispatch resolver can read it.
    const q = classes.find((c) => c.name === "GetRoleHoldersQuery")!;
    expect([q.extends, ...(q.implements ?? [])].join(" ")).toMatch(/IRequest</);
  });

  it("captures `record struct` types (e.g. the ErrorOr `Error` factory)", async () => {
    const SRC = `namespace X;
public readonly record struct Error {
  public static Error Forbidden(string code) => default;
}`;
    const classes = await classesOf(SRC);
    const err = classes.find((c) => c.name === "Error");
    expect(err).toBeDefined();
    expect(err!.methods.map((m) => m.name)).toContain("Forbidden");
  });
});

describe("C# functions-classes — dependency-injection facts", () => {
  const byName = (classes: ClassInfo[], name: string): ClassInfo => classes.find((c) => c.name === name)!;

  it("reports constructors as methods named after the class, with their params and calls", async () => {
    const classes = await classesOf(`class CheckoutService {
  private readonly ICarRepo _repo;
  public CheckoutService(ICarRepo repo, IPricing pricing) { _repo = repo; _repo.Get(0); }
  static CheckoutService() { }
  public CheckoutService(ICarRepo repo) : this(repo, null) => Init(repo);
}`);
    const ctors = byName(classes, "CheckoutService").methods.filter((m) => m.name === "CheckoutService");
    expect(ctors).toHaveLength(3);
    expect(ctors[0]!.params.map((p) => [p.name, p.type])).toEqual([["repo", "ICarRepo"], ["pricing", "IPricing"]]);
    expect(ctors[0]!.calls.map((c) => c.name)).toEqual(["_repo.Get"]);
    expect(ctors[2]!.calls.map((c) => c.name)).toEqual(["Init"]);
  });

  it("reports a primary constructor (class, struct, record) as a constructor with its params", async () => {
    const classes = await classesOf(`public class ReportService(IReportStore store, [FromKeyedServices("x")] CarService cars) {
  public string Run() => store.Load();
}
public struct Point(int x, int y) : IShape { }
public record Dto(Guid Id, string Name) : Base(Id);
public class Plain { }`);
    const report = byName(classes, "ReportService");
    expect(report.methods[0]).toMatchObject({ name: "ReportService", line: 1, calls: [] });
    expect(report.methods[0]!.params).toEqual([
      { name: "store", type: "IReportStore", defaultValue: null },
      { name: "cars", type: "CarService", defaultValue: null, qualifier: "x" },
    ]);
    expect(byName(classes, "Point").methods.map((m) => m.name)).toEqual(["Point"]);
    expect(byName(classes, "Dto").methods[0]!.params.map((p) => p.name)).toEqual(["Id", "Name"]);
    expect(byName(classes, "Plain").methods).toEqual([]);
  });

  it("names each base type once, as written — never a primary-constructor argument list", async () => {
    const classes = await classesOf(`class S(IRepo repo) : Base(repo), IFoo<int>, N.IBar { }
public record R(int N) : BaseRecord(N), IEquatable<R>;
class Q : IQuery<List<int>> /* note */ , IOther { }`);
    expect(byName(classes, "S")).toMatchObject({ extends: "Base", implements: ["IFoo<int>", "N.IBar"] });
    expect(byName(classes, "R")).toMatchObject({ extends: "BaseRecord", implements: ["IEquatable<R>"] });
    expect(byName(classes, "Q")).toMatchObject({ extends: "IQuery<List<int>>", implements: ["IOther"] });
  });

  it("reads the DI key of a parameter from [FromKeyedServices] / Autofac [KeyFilter], not from [FromServices]", async () => {
    const classes = await classesOf(`class C {
  public C([KeyFilter("csv")] IExporter exporter, [FromKeyedServices(nameof(BlobStorage))] IStorage blob) { }
  public void M([FromKeyedServices("disk")] IStorage s, [FromServices] IAudit audit, [Required] string name) { }
}`);
    const [ctor, m] = byName(classes, "C").methods;
    expect(ctor!.params.map((p) => p.qualifier)).toEqual(["csv", "BlobStorage"]);
    expect(m!.params.map((p) => p.qualifier)).toEqual(["disk", undefined, undefined]);
  });

  it("reads the DI key of an injected property ([Inject(Key = …)], Unity [Dependency(…)])", async () => {
    const classes = await classesOf(`class Page {
  [Inject(Key = "blob")] public IStorage Storage { get; set; }
  [Inject] public IAudit Audit { get; set; }
  [Dependency("fast")] public ICache Cache { get; set; }
}`);
    expect(byName(classes, "Page").properties.map((p) => [p.name, p.qualifier])).toEqual([
      ["Storage", "blob"], ["Audit", undefined], ["Cache", "fast"],
    ]);
  });

  it("gives a field that stores a keyed constructor parameter that parameter's key", async () => {
    const classes = await classesOf(`class A {
  private readonly IStorage _storage;
  private readonly IStorage _other;
  private readonly IAudit _audit;
  private readonly IStorage _twice;
  public A([FromKeyedServices("disk")] IStorage storage, [FromKeyedServices("blob")] IStorage other, IAudit audit) {
    _storage = storage;
    this._other = other ?? throw new ArgumentNullException(nameof(other));
    _audit = audit;
    _twice = storage;
  }
  public A([FromKeyedServices("blob")] IStorage s) { _twice = s; }
}
class B([FromKeyedServices("k")] IStorage store, IAudit audit) {
  private readonly IStorage _store = store;
  private readonly IAudit _audit = audit;
}`);
    expect(byName(classes, "A").properties.map((p) => [p.name, p.qualifier])).toEqual([
      ["_storage", "disk"], ["_other", "blob"], ["_audit", undefined], ["_twice", undefined],
    ]);
    expect(byName(classes, "B").properties.map((p) => [p.name, p.qualifier])).toEqual([
      ["_store", "k"], ["_audit", undefined],
    ]);
  });
});

describe("C# functions-classes — extension methods", () => {
  it("marks the `this` parameter of an extension method as the call's receiver", async () => {
    const classes = await classesOf(`public static class FastReportExtensions {
  public static TextObject AddStaticRowElement(this BandBase band, string text, float width) { return null; }
  public static void Plain(BandBase band) { }
}`);
    const [ext, plain] = classes[0]!.methods;
    expect(ext!.params.map((p) => p.isReceiver)).toEqual([true, undefined, undefined]);
    expect(plain!.params[0]!.isReceiver).toBeUndefined();
  });
});

describe("C# functions-classes — constructed fields", () => {
  it("types a private field the class only ever constructs as the constructed class", async () => {
    const classes = await classesOf(`class Svc {
  private readonly IClock _clock = new SystemClock();
  private readonly IMailer _mailer;
  private readonly IRepo _repo;
  private readonly IAudit _audit;
  private IStore _store = new MemStore();
  private ICache _cache;
  public IClock PublicClock = new SystemClock();
  public Svc(IRepo repo, IAudit audit) {
    _mailer = new SmtpMailer("h");
    this._repo = repo;
    _audit = audit ?? new NullAudit();
    _cache = new RedisCache();
  }
  public void Reset() { _store = new DiskStore(); _cache = new RedisCache(); }
}`);
    expect(classes[0]!.properties.map((p) => [p.name, p.type])).toEqual([
      ["_clock", "SystemClock"],
      ["_mailer", "SmtpMailer"],
      ["_repo", "IRepo"],
      ["_audit", "IAudit"],
      // Two different classes stored: the declared type stands.
      ["_store", "IStore"],
      ["_cache", "RedisCache"],
      // Public fields keep their declared type (request schemas read it).
      ["PublicClock", "IClock"],
    ]);
  });
});

describe("C# functions-classes — typed locals", () => {
  async function localsOf(body: string): Promise<unknown> {
    const classes = await classesOf(`class C { void M(IServiceProvider sp, IContainer c, object o) {\n${body}\n} }`);
    return classes[0]!.methods[0]!.localTypes;
  }

  it("types constructed, target-typed and declared locals", async () => {
    expect(await localsOf(`var calc = new DiscountCalc();
DiscountCalc calc2 = new();
IPricing p = new Pricing();
IPricing q = Create();
Shop.Domain.IAudit? a = null;
List<Car> cars = new List<Car>();
using var u = new UnitOfWork();
int n = 0;`)).toEqual([
      { name: "calc", type: "DiscountCalc" },
      { name: "calc2", type: "DiscountCalc" },
      { name: "q", type: "IPricing" },
      { name: "a", type: "Shop.Domain.IAudit?" },
      { name: "u", type: "UnitOfWork" },
      // `T x = new U()`: the constructed class once the body never reassigns `x`.
      { name: "p", type: "Pricing" },
      { name: "cars", type: "List<Car>" },
    ]);
  });

  it("keeps the declared type when a constructed local is reassigned", async () => {
    expect(await localsOf(`IPricing p = new Pricing();
p = new DiscountPricing();`)).toEqual([{ name: "p", type: "IPricing" }]);
  });

  it("types locals fetched from a container, with the key a keyed lookup names", async () => {
    expect(await localsOf(`var a = sp.GetRequiredService<IPricing>();
var b = sp.GetService<IAudit>()!;
var t = (IClock)sp.GetService(typeof(IClock))!;
var s = sp.GetService(typeof(IMailer)) as IMailer;
var k = sp.GetRequiredKeyedService<IStorage>("blob");
IStorage k2 = sp.GetKeyedService<IStorage>(StorageKeys.Disk);
var r = c.Resolve<IPlayerStore>();
var n = c.ResolveNamed<IPlayerStore>("mongo");
var x = Build();
var y = sp.GetServices<IPlugin>();`)).toEqual([
      { name: "a", type: "IPricing" },
      { name: "b", type: "IAudit" },
      { name: "t", type: "IClock" },
      { name: "s", type: "IMailer" },
      { name: "k", type: "IStorage", qualifier: "blob" },
      { name: "k2", type: "IStorage", qualifier: "StorageKeys.Disk" },
      { name: "r", type: "IPlayerStore" },
      { name: "n", type: "IPlayerStore", qualifier: "mongo" },
      // No stated type: typed later by what each call is declared to return.
      { name: "x", type: "", from: "Build()" },
      { name: "y", type: "", from: "sp.GetServices<IPlugin>()" },
    ]);
  });

  it("keeps the call a `var` local is initialized from, awaited or not", async () => {
    expect(await localsOf(`var u = repo.Find(id);
var a = await repo.FindAsync(id);
var c = await (repo.FindAsync(id)).ConfigureAwait(false);
var n = 5 + Count();`)).toEqual([
      { name: "u", type: "", from: "repo.Find()" },
      { name: "a", type: "", from: "repo.FindAsync()", awaited: true },
      { name: "c", type: "", from: "repo.FindAsync()", awaited: true },
    ]);
  });

  it("types foreach / pattern / out variables and an argument lambda's typed parameters", async () => {
    expect(await localsOf(`foreach (Car item in items) item.Ship();
foreach (var any in items) any.Ship();
if (o is Bill bill) bill.Send();
TryGet(out Receipt rcp);
list.ForEach((IRepo repo) => repo.Save());
Func<IRepo, int> named = (IRepo hidden) => hidden.Count();`)).toEqual([
      { name: "item", type: "Car" },
      { name: "bill", type: "Bill" },
      { name: "rcp", type: "Receipt" },
      { name: "repo", type: "IRepo" },
      // The delegate itself is a typed local; its lambda is a scope of its own.
      { name: "named", type: "Func<IRepo, int>" },
    ]);
  });

  it("leaves out a name declared with two types, and locals of a local function", async () => {
    expect(await localsOf(`{ var x = new A(); x.Run(); }
{ var x = new B(); x.Run(); }
var y = new C();
void Local() { var z = new D(); }`)).toEqual([{ name: "y", type: "C" }]);
  });

  it("has no localTypes when the body declares none", async () => {
    expect(await localsOf(`sp.GetRequiredService<IPricing>().Quote(o);`)).toBeUndefined();
  });
});

describe("nested types", () => {
  it("extracts nested classes and records with their own members", async () => {
    const classes = await classesOf(`
namespace App;
public class Cars {
  public record Command(int Id);
  public class Handler { public int Handle(Command c) => c.Id; }
}`);
    expect(classes.map((c) => `${c.name}[${c.methods.map((m) => m.name)}]`)).toEqual(["Cars[]", "Command[Command]", "Handler[Handle]"]);
  });
});

describe("C# functions-classes — declared types", () => {
  it("records a method's return type and a generic class's type parameters", async () => {
    const [ext, handler] = await classesOf(`namespace X;
public static class InjuryExtensions {
  public static CreatePlayerInjuryCommand ToCreateCommand(this AbsenceRequest r) => new();
  public async Task<IEnumerable<Note>> List(Guid id) { return null; }
}
public abstract class BaseHandler<T, K> : IRequestHandler<T, K> where T : IRequest<K> { }`);
    expect(ext!.methods.map((m) => `${m.name}: ${m.returnType}`)).toEqual([
      "ToCreateCommand: CreatePlayerInjuryCommand",
      "List: Task<IEnumerable<Note>>",
    ]);
    expect(handler!.typeParameters).toEqual(["T", "K"]);
  });

  it("states what a class gives its string fields and passes to its base", async () => {
    const [base, sub] = await classesOf(`namespace X;
public abstract class BaseLeagueDataHttpClient {
  protected const string BasePath = "api";
  protected readonly string BaseVersion;
  protected BaseLeagueDataHttpClient(string baseVersion, HttpClient httpClient) { BaseVersion = baseVersion; }
}
public class LeagueDataV2HttpClient : BaseLeagueDataHttpClient {
  public LeagueDataV2HttpClient(HttpClient httpClient) : base("v2", httpClient) { }
}`);
    expect(base!.fieldValues).toEqual({ BasePath: "api", BaseVersion: "${baseVersion}" });
    expect(sub!.superArgs).toEqual(["v2", "${httpClient}"]);
  });
});
