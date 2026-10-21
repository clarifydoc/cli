import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractCsharpDiBindings } from "./di-bindings.js";
import type { DiBinding } from "../../../types/analysis.js";

async function bindingsOf(body: string): Promise<DiBinding[]> {
  const src = `class C { void M(IServiceCollection services, ContainerBuilder builder, Container container) {\n${body}\n} }`;
  const tree = await parseSource(src, "csharp" as any, "C.cs");
  return extractCsharpDiBindings(tree, src);
}

/** The bindings without `line`, for compact expectations. */
async function factsOf(body: string): Promise<Array<Omit<DiBinding, "line">>> {
  return (await bindingsOf(body)).map(({ line: _line, ...rest }) => rest);
}

describe("C# DI bindings — Microsoft.Extensions.DependencyInjection", () => {
  it("reads Add{Lifetime}<I, T>() on any receiver, with the registration's line", async () => {
    const b = await bindingsOf(`services.AddScoped<IFoo, Foo>();
builder.Services.AddTransient<IBar, Bar>();
services.AddSingleton<Shop.Domain.IClock, Shop.Infra.SystemClock>();`);
    expect(b).toEqual([
      { service: "IFoo", implementation: "Foo", line: 2, via: "AddScoped" },
      { service: "IBar", implementation: "Bar", line: 3, via: "AddTransient" },
      { service: "IClock", implementation: "SystemClock", line: 4, via: "AddSingleton" },
    ]);
  });

  it("marks TryAdd* as a default that yields to a real registration — and still reports both", async () => {
    expect(await factsOf(`services.AddScoped<ITax, EuTax>();
services.TryAddScoped<ITax, UsTax>();`)).toEqual([
      { service: "ITax", implementation: "EuTax", via: "AddScoped" },
      { service: "ITax", implementation: "UsTax", via: "TryAddScoped", ifAbsent: true },
    ]);
  });

  it("reports two disagreeing unconditional registrations (the core refuses to choose)", async () => {
    expect(await factsOf(`services.AddScoped<IShipping, Ups>();
services.AddScoped<IShipping, Fedex>();`)).toEqual([
      { service: "IShipping", implementation: "Ups", via: "AddScoped" },
      { service: "IShipping", implementation: "Fedex", via: "AddScoped" },
    ]);
  });

  it("reads keyed registrations: the key is the qualifier and only it reaches them", async () => {
    expect(await factsOf(`services.AddKeyedScoped<IStorage, BlobStorage>("blob");
services.TryAddKeyedSingleton<IStorage, DiskStorage>(@"disk");
services.AddKeyedTransient<IStorage, S3Storage>(nameof(S3Storage));
services.AddKeyedScoped<IStorage, NasStorage>(StorageKeys.Nas);
services.AddKeyedSingleton<IStorage>("mem", (sp, key) => { return new MemStorage(); });`)).toEqual([
      { service: "IStorage", implementation: "BlobStorage", via: "AddKeyedScoped", qualifier: "blob", keyedOnly: true },
      { service: "IStorage", implementation: "DiskStorage", via: "TryAddKeyedSingleton", qualifier: "disk", keyedOnly: true, ifAbsent: true },
      { service: "IStorage", implementation: "S3Storage", via: "AddKeyedTransient", qualifier: "S3Storage", keyedOnly: true },
      { service: "IStorage", implementation: "NasStorage", via: "AddKeyedScoped", qualifier: "StorageKeys.Nas", keyedOnly: true },
      { service: "IStorage", implementation: "MemStorage", via: "AddKeyedSingleton", qualifier: "mem", keyedOnly: true },
    ]);
  });

  it("reads typeof forms, open generics included", async () => {
    expect(await factsOf(`services.AddScoped(typeof(IAudit), typeof(DbAudit));
services.AddScoped(typeof(IRepository<>), typeof(EfRepository<>));
services.AddKeyedScoped(typeof(IAudit), "file", typeof(FileAudit));`)).toEqual([
      { service: "IAudit", implementation: "DbAudit", via: "AddScoped" },
      { service: "IRepository", implementation: "EfRepository", via: "AddScoped" },
      { service: "IAudit", implementation: "FileAudit", via: "AddKeyedScoped", qualifier: "file", keyedOnly: true },
    ]);
  });

  it("takes a factory's implementation from what it constructs or forwards to", async () => {
    expect(await factsOf(`services.AddScoped<IMailer>(sp => new SmtpMailer(sp.GetRequiredService<IConfig>()));
services.AddScoped<ICarRepo>(sp => sp.GetRequiredService<SqlCarRepo>());
services.AddSingleton<IClock>(_ => { var c = 1; return new SystemClock(); });
services.AddScoped(typeof(IAudit), sp => (IAudit)new DbAudit());
services.AddScoped<IBall>(sp => ActivatorUtilities.CreateInstance<Ball>(sp));
services.AddSingleton<ICache>(sp => flag ? new RedisCache() : new RedisCache());`)).toEqual([
      { service: "IMailer", implementation: "SmtpMailer", via: "AddScoped" },
      { service: "ICarRepo", implementation: "SqlCarRepo", via: "AddScoped" },
      { service: "IClock", implementation: "SystemClock", via: "AddSingleton" },
      { service: "IAudit", implementation: "DbAudit", via: "AddScoped" },
      { service: "IBall", implementation: "Ball", via: "AddScoped" },
      { service: "ICache", implementation: "RedisCache", via: "AddSingleton" },
    ]);
  });

  it("emits nothing for a factory or instance whose class the source does not state", async () => {
    expect(await factsOf(`services.AddScoped<IMailer>(sp => Create(sp));
services.AddScoped<IMailer>(CreateMailer);
services.AddSingleton<ICache>(sp => flag ? new RedisCache() : new MemoryCache());
services.AddSingleton<IClock>(sp => { if (x) return new A(); return new B(); });
services.AddSingleton<ICache>(existingCache);
services.AddScoped<IStore>(sp => sp.GetRequiredKeyedService<IStore>("k"));`)).toEqual([]);
  });

  it("reads instance registrations", async () => {
    expect(await factsOf(`services.AddSingleton<ICacheStore>(new RedisCacheStore());
services.AddSingleton(typeof(IClock), new SystemClock());`)).toEqual([
      { service: "ICacheStore", implementation: "RedisCacheStore", via: "AddSingleton" },
      { service: "IClock", implementation: "SystemClock", via: "AddSingleton" },
    ]);
  });

  it("skips self registrations", async () => {
    expect(await factsOf(`services.AddTransient<CarService>();
services.AddScoped<CarService, CarService>();
services.AddScoped(typeof(CarService));
services.AddSingleton(new CarService());
services.AddHttpClient<WeatherClient>();
services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));`)).toEqual([]);
  });

  it("reads AddHttpClient<I, T>, AddDbContext<I, T> and Scrutor Decorate<I, D>", async () => {
    expect(await factsOf(`services.AddHttpClient<IWeatherClient, WeatherClient>(c => c.BaseAddress = uri);
services.AddDbContext<IAppDb, AppDb>(o => o.UseNpgsql(cs));
services.Decorate<ICarRepo, CachedCarRepo>();`)).toEqual([
      { service: "IWeatherClient", implementation: "WeatherClient", via: "AddHttpClient" },
      { service: "IAppDb", implementation: "AppDb", via: "AddDbContext" },
      { service: "ICarRepo", implementation: "CachedCarRepo", via: "Decorate" },
    ]);
  });

  it("reads a project helper named for the registration it wraps, not its own generic body", async () => {
    const src = `class Startup {
  protected void AddHttpClient<TInterface, TImplementation>(IServiceCollection services, string name, string url)
      where TImplementation : class, TInterface {
    services.AddHttpClient<TInterface, TImplementation>(name, c => c.BaseAddress = new Uri(url));
  }
  void Configure(IServiceCollection services) {
    AddHttpClient<IPlanV3HttpClient, PlanV3HttpClient>(services, "PlanHttpClient", PlanUrl());
    services.AddTransient<IPlanHttpClient>(provider => provider.GetRequiredService<IPlanV3HttpClient>());
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "Startup.cs");
    expect(extractCsharpDiBindings(tree, src).map(({ line: _l, ...b }) => b)).toEqual([
      { service: "IPlanV3HttpClient", implementation: "PlanV3HttpClient", via: "AddHttpClient" },
      { service: "IPlanHttpClient", implementation: "IPlanV3HttpClient", via: "AddTransient" },
    ]);
  });

  it("reads ServiceDescriptor registrations added to the collection", async () => {
    expect(await factsOf(`services.Add(ServiceDescriptor.Scoped<IFoo, Foo>());
services.TryAdd(new ServiceDescriptor(typeof(IBar), typeof(Bar), ServiceLifetime.Scoped));
services.Replace(ServiceDescriptor.Singleton<IClock>(sp => new FakeClock()));
services.Add(ServiceDescriptor.Describe(typeof(IAudit), typeof(DbAudit), ServiceLifetime.Transient));
services.Add(new ServiceDescriptor(typeof(IStorage), "blob", typeof(BlobStorage), ServiceLifetime.Scoped));
services.Add(new ServiceDescriptor(typeof(ICache), new RedisCache()));
services.TryAddEnumerable(ServiceDescriptor.KeyedScoped<IStorage, DiskStorage>("disk"));
list.Add(item);`)).toEqual([
      { service: "IFoo", implementation: "Foo", via: "Add(ServiceDescriptor)" },
      { service: "IBar", implementation: "Bar", via: "TryAdd(ServiceDescriptor)", ifAbsent: true },
      { service: "IClock", implementation: "FakeClock", via: "Replace(ServiceDescriptor)" },
      { service: "IAudit", implementation: "DbAudit", via: "Add(ServiceDescriptor)" },
      { service: "IStorage", implementation: "BlobStorage", via: "Add(ServiceDescriptor)", qualifier: "blob", keyedOnly: true },
      { service: "ICache", implementation: "RedisCache", via: "Add(ServiceDescriptor)" },
      { service: "IStorage", implementation: "DiskStorage", via: "TryAddEnumerable(ServiceDescriptor)", qualifier: "disk", keyedOnly: true },
    ]);
  });

  it("reads registrations inside an extension-method module", async () => {
    const src = `public static class Billing {
  public static IServiceCollection AddBilling(this IServiceCollection s) {
    s.AddScoped<IBillSender, PdfBillSender>().AddSingleton<IClock, SystemClock>();
    return s;
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "Billing.cs");
    // A chained `s.AddScoped<…>().AddSingleton<…>()` is two registrations.
    expect(extractCsharpDiBindings(tree, src).map((b) => `${b.service}->${b.implementation}`).sort()).toEqual([
      "IBillSender->PdfBillSender",
      "IClock->SystemClock",
    ]);
  });

  it("skips a registration that names a generic helper's type parameter", async () => {
    const src = `static class Rabbit {
  public static void AddConsumer<TConsumer>(IServiceCollection services) where TConsumer : BaseConsumer {
    services.AddTransient<BaseConsumer, TConsumer>();
    services.AddSingleton<IPool, Pool>();
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "Rabbit.cs");
    expect(extractCsharpDiBindings(tree, src).map((b) => `${b.service}->${b.implementation}`)).toEqual(["IPool->Pool"]);
  });

  it("skips files with no registration without walking them", async () => {
    const src = `class C { void M() { list.Add(x); cache.Register(y); } }`;
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    expect(extractCsharpDiBindings(tree, src)).toEqual([]);
  });
});

describe("C# DI bindings — Autofac", () => {
  it("reads RegisterType<T>().As<I>() chains, any modifiers in between", async () => {
    expect(await factsOf(`builder.RegisterType<SqlPlayerStore>().As<IPlayerStore>().InstancePerLifetimeScope();
builder.RegisterType<Multi>().InstancePerDependency().As<IA, IB>();
builder.RegisterType(typeof(Clock)).As(typeof(IClock));`)).toEqual([
      { service: "IPlayerStore", implementation: "SqlPlayerStore", via: "RegisterType.As" },
      { service: "IA", implementation: "Multi", via: "RegisterType.As" },
      { service: "IB", implementation: "Multi", via: "RegisterType.As" },
      { service: "IClock", implementation: "Clock", via: "RegisterType.As" },
    ]);
  });

  it("reads Keyed/Named as key-only unless As<I>() also exposes the type", async () => {
    expect(await factsOf(`builder.RegisterType<CsvExporter>().Keyed<IExporter>("csv");
builder.Register(c => new MongoPlayerStore()).Named<IPlayerStore>("mongo");
builder.RegisterType<JsonExporter>().As<IExporter>().Keyed<IExporter>("json");
builder.RegisterType<XmlExporter>().Keyed("xml", typeof(IExporter));`)).toEqual([
      { service: "IExporter", implementation: "CsvExporter", via: "RegisterType.Keyed", qualifier: "csv", keyedOnly: true },
      { service: "IPlayerStore", implementation: "MongoPlayerStore", via: "Register.Named", qualifier: "mongo", keyedOnly: true },
      { service: "IExporter", implementation: "JsonExporter", via: "RegisterType.As" },
      { service: "IExporter", implementation: "JsonExporter", via: "RegisterType.Keyed", qualifier: "json" },
      { service: "IExporter", implementation: "XmlExporter", via: "RegisterType.Keyed", qualifier: "xml", keyedOnly: true },
    ]);
  });

  it("marks PreserveExistingDefaults / IfNotRegistered as defaults", async () => {
    expect(await factsOf(`builder.RegisterType<OldLegacy>().As<ILegacy>();
builder.RegisterType<NewLegacy>().As<ILegacy>().PreserveExistingDefaults();
builder.RegisterType<Fallback>().As<ILegacy>().IfNotRegistered(typeof(ILegacy));`)).toEqual([
      { service: "ILegacy", implementation: "OldLegacy", via: "RegisterType.As" },
      { service: "ILegacy", implementation: "NewLegacy", via: "RegisterType.As", ifAbsent: true },
      { service: "ILegacy", implementation: "Fallback", via: "RegisterType.As", ifAbsent: true },
    ]);
  });

  it("reads lambda, instance and open-generic registrations", async () => {
    expect(await factsOf(`builder.Register(c => new Mailer(c.Resolve<IConfig>())).As<IMailer>();
builder.Register<IClock>(c => new SystemClock());
builder.RegisterInstance(new RedisCache()).As<ICache>().SingleInstance();
builder.RegisterGeneric(typeof(EfRepository<>)).As(typeof(IRepository<>));
builder.RegisterDecorator<LoggingMailer, IMailer>();`)).toEqual([
      { service: "IMailer", implementation: "Mailer", via: "Register.As" },
      { service: "IClock", implementation: "SystemClock", via: "Register" },
      { service: "ICache", implementation: "RedisCache", via: "RegisterInstance.As" },
      { service: "IRepository", implementation: "EfRepository", via: "RegisterGeneric.As" },
      { service: "IMailer", implementation: "LoggingMailer", via: "RegisterDecorator" },
    ]);
  });

  it("exposes the interfaces the implementation's own declaration in this file names", async () => {
    const src = `class Module1 { void Load(ContainerBuilder builder) {
  builder.RegisterType<SlackSink>().AsImplementedInterfaces();
  builder.RegisterType<Elsewhere>().AsImplementedInterfaces();
  builder.RegisterType<Derived>().AsImplementedInterfaces();
} }
public interface IAlertSink { void Alert(string m); }
public class SlackSink : IAlertSink, IDisposable, Shop.IHealth { }
public class BaseSink { }
public class Derived : BaseSink, IAlertSink { }`;
    const tree = await parseSource(src, "csharp" as any, "Module1.cs");
    expect(extractCsharpDiBindings(tree, src).map(({ line: _l, ...b }) => b)).toEqual([
      { service: "IAlertSink", implementation: "SlackSink", via: "RegisterType.AsImplementedInterfaces" },
      { service: "IHealth", implementation: "SlackSink", via: "RegisterType.AsImplementedInterfaces" },
      // `Elsewhere` is declared in another file: the linker expands it from that declaration.
      { service: "", implementation: "Elsewhere", via: "RegisterType.AsImplementedInterfaces", allInterfaces: true },
      { service: "IAlertSink", implementation: "Derived", via: "RegisterType.AsImplementedInterfaces" },
    ]);
  });

  it("treats every base of a struct as an interface (structs have no base class)", async () => {
    const src = `class M { void Load(ContainerBuilder b) {
  b.RegisterType<Money>().AsImplementedInterfaces();
  b.RegisterType<Cash>().AsImplementedInterfaces();
} }
public record struct Money(int A) : Comparable;
public class Cash : Comparable { }`;
    const tree = await parseSource(src, "csharp" as any, "M.cs");
    expect(extractCsharpDiBindings(tree, src).map((b) => `${b.service}->${b.implementation}`)).toEqual(["Comparable->Money"]);
  });

  it("does not report what the source cannot state: self registrations, assembly scanning", async () => {
    expect(await factsOf(`builder.RegisterType<PlayerService>().AsSelf().WithAttributeFiltering();
builder.RegisterType<PlayerService>();
builder.RegisterAssemblyTypes(typeof(A).Assembly).Where(t => t.Name.EndsWith("Repo")).AsImplementedInterfaces();
builder.Register(c => Build(c)).As<IBall>();`)).toEqual([]);
  });
});

describe("C# DI bindings — Register<I, T>() containers", () => {
  it("reads Simple Injector / Unity / DryIoc / LightInject pair registrations; a name makes them key-only", async () => {
    expect(await factsOf(`container.Register<IFoo, Foo>(Lifestyle.Scoped);
container.RegisterSingleton<IBar, Bar>();
container.RegisterType<IBaz, NamedBaz>("special");
container.Register<IQux, KeyedQux>(Reuse.Singleton, serviceKey: "k");
container.Register(typeof(IAudit), typeof(DbAudit));
container.Register<IClock>(() => new SystemClock(), Lifestyle.Singleton);
container.RegisterInstance<ICache>(new RedisCache());`)).toEqual([
      { service: "IFoo", implementation: "Foo", via: "Register" },
      { service: "IBar", implementation: "Bar", via: "RegisterSingleton" },
      { service: "IBaz", implementation: "NamedBaz", via: "RegisterType", qualifier: "special", keyedOnly: true },
      { service: "IQux", implementation: "KeyedQux", via: "Register", qualifier: "k", keyedOnly: true },
      { service: "IAudit", implementation: "DbAudit", via: "Register" },
      { service: "IClock", implementation: "SystemClock", via: "Register" },
      { service: "ICache", implementation: "RedisCache", via: "RegisterInstance" },
    ]);
  });
});
