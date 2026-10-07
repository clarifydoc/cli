import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractJvmDiBindings } from "./di-bindings.js";
import { terminateAnnotatedDeclarations } from "./kotlin-preprocess.js";
import type { DiBinding } from "../../../types/analysis.js";

async function bindingsOf(src: string, lang: "java" | "kotlin"): Promise<DiBinding[]> {
  // Kotlin goes through the plugin's preprocess, as in the pipeline.
  const text = lang === "kotlin" ? terminateAnnotatedDeclarations(src) ?? src : src;
  const tree = await parseSource(text, lang as any, lang === "java" ? "X.java" : "X.kt");
  return extractJvmDiBindings(tree, text, lang);
}

/** The bindings without `line`, for compact expectations. */
async function factsOf(src: string, lang: "java" | "kotlin"): Promise<Array<Omit<DiBinding, "line">>> {
  return (await bindingsOf(src, lang)).map(({ line: _line, ...rest }) => rest);
}

describe("JVM DI bindings — Spring stereotypes", () => {
  it("binds each implemented interface to the class under its bean name, with the registration's line", async () => {
    expect(await bindingsOf(`package a;
@Component
public class AuditTrail implements Auditable, com.x.Closeable2<T> { }
@Service("disk")
class DiskStorage implements Storage { }
@Component(value = "fast") @Primary
class URLCache implements Cache<String> { }`, "java")).toEqual([
      { service: "Auditable", implementation: "AuditTrail", line: 2, via: "@Component", qualifier: "auditTrail", matchesMemberName: true },
      { service: "Closeable2", implementation: "AuditTrail", line: 2, via: "@Component", qualifier: "auditTrail", matchesMemberName: true },
      { service: "Storage", implementation: "DiskStorage", line: 4, via: "@Service", qualifier: "disk", matchesMemberName: true },
      { service: "Cache", implementation: "URLCache", line: 6, via: "@Component", qualifier: "fast", matchesMemberName: true, primary: true },
    ]);
  });

  it("keeps an all-caps prefix in the default bean name (Introspector.decapitalize)", async () => {
    expect((await factsOf(`@Component class URLParser implements Parser {}`, "java"))[0]!.qualifier).toBe("URLParser");
  });

  it("adds a class-level @Qualifier as a second key", async () => {
    expect(await factsOf(`@Component @Qualifier("sms") class SmsNotifier implements Notifier {}`, "java")).toEqual([
      { service: "Notifier", implementation: "SmsNotifier", via: "@Component", qualifier: "smsNotifier", matchesMemberName: true },
      { service: "Notifier", implementation: "SmsNotifier", via: "@Qualifier", qualifier: "sms" },
    ]);
  });

  it("reads Kotlin stereotypes, superclass excluded, and nested classes", async () => {
    expect(await factsOf(`package a
@Component("s3")
class S3Storage : BaseStorage(), Storage {
    override fun put(key: String) {}
}

@Configuration
class Outer {
    @Service
    class Inner : Api
}`, "kotlin")).toEqual([
      { service: "Storage", implementation: "S3Storage", via: "@Component", qualifier: "s3", matchesMemberName: true },
      { service: "Api", implementation: "Inner", via: "@Service", qualifier: "inner", matchesMemberName: true },
    ]);
  });

  it("reports nothing for interfaces, abstract classes, concrete-only beans and the superclass", async () => {
    expect(await factsOf(`@Repository interface UserRepo extends JpaRepository<User, Long> {}
@Component abstract class Base implements Api {}
@Component class Clock {}
@Service class Sub extends Base {}
class Plain implements Api {}`, "java")).toEqual([]);
  });
});

describe("JVM DI bindings — @Bean methods", () => {
  it("binds the declared type to the returned construction, named by the method or @Bean names", async () => {
    expect(await factsOf(`@Configuration
public class AppConfig {
  @Bean public Tokenizer tokenizer() { return new RegexTokenizer(); }
  @Bean(name = {"a", "b"}) @Primary Notifier notifier() { return new MailNotifier(cfg); }
  @Bean("cache") Cache cache(RedisCache redis) { return redis; }
  @Bean @ConditionalOnMissingBean Clock clock() { return new SystemClock(); }
  @Bean(autowireCandidate = false) Clock hidden() { return new FakeClock(); }
}`, "java")).toEqual([
      { service: "Tokenizer", implementation: "RegexTokenizer", via: "@Bean", qualifier: "tokenizer", matchesMemberName: true },
      { service: "Notifier", implementation: "MailNotifier", via: "@Bean", qualifier: "a", matchesMemberName: true, primary: true },
      { service: "Notifier", implementation: "MailNotifier", via: "@Bean", qualifier: "b", matchesMemberName: true, primary: true },
      { service: "Cache", implementation: "RedisCache", via: "@Bean", qualifier: "cache", matchesMemberName: true },
      { service: "Clock", implementation: "SystemClock", via: "@Bean", qualifier: "clock", matchesMemberName: true, ifAbsent: true },
    ]);
  });

  it("registers the declared type itself when the body is no single construction — so it still competes", async () => {
    expect(await factsOf(`class C {
  @Bean Notifier sms() { return factory.create(); }
  @Bean Notifier pick() { if (x) return new A(); return new B(); }
  @Bean Runnable task() { return new Runnable() { public void run() {} }; }
  @Bean String appName() { return "x"; }
}`, "java")).toEqual([
      { service: "Notifier", implementation: "Notifier", via: "@Bean", qualifier: "sms", matchesMemberName: true },
      { service: "Notifier", implementation: "Notifier", via: "@Bean", qualifier: "pick", matchesMemberName: true },
      { service: "Runnable", implementation: "Runnable", via: "@Bean", qualifier: "task", matchesMemberName: true },
    ]);
  });

  it("reads Kotlin @Bean functions (expression and block bodies, apply chains)", async () => {
    expect(await factsOf(`package a
@Configuration
class Cfg {
    @Bean fun tok(): Tokenizer = RegexTokenizer()
    @Bean fun mail(): Mailer { return SmtpMailer().apply { host = "x" } }
    @Bean fun repo() = OrderRepo()
}`, "kotlin")).toEqual([
      { service: "Tokenizer", implementation: "RegexTokenizer", via: "@Bean", qualifier: "tok", matchesMemberName: true },
      { service: "Mailer", implementation: "SmtpMailer", via: "@Bean", qualifier: "mail", matchesMemberName: true },
      { service: "OrderRepo", implementation: "OrderRepo", via: "@Bean", qualifier: "repo", matchesMemberName: true },
    ]);
  });
});

describe("JVM DI bindings — Guice", () => {
  it("reads bind(..).to(..) chains, annotatedWith keys, toInstance, binder() receivers and scopes", async () => {
    expect(await factsOf(`public class AppModule extends AbstractModule {
  @Override protected void configure() {
    bind(Pricing.class).to(DiscountPricing.class);
    bind(Sorter.class).annotatedWith(Names.named("fast")).to(QuickSorter.class).in(Singleton.class);
    bind(Sorter.class).annotatedWith(Slow.class).to(BubbleSorter.class);
    binder().bind(Geo.class).toInstance(new LocalGeo());
    bind(Key.get(Cache.class, Names.named("l1"))).to(MemCache.class);
    bind(Clock.class).toProvider(ClockProvider.class);
    bind(Impl.class).asEagerSingleton();
    bind(Impl.class).to(Impl.class);
    view.bind(model);
  }
}`, "java")).toEqual([
      { service: "Pricing", implementation: "DiscountPricing", via: "bind" },
      { service: "Sorter", implementation: "QuickSorter", via: "bind", qualifier: "fast", keyedOnly: true },
      { service: "Sorter", implementation: "BubbleSorter", via: "bind", qualifier: "Slow", keyedOnly: true },
      { service: "Geo", implementation: "LocalGeo", via: "bind" },
      { service: "Cache", implementation: "MemCache", via: "bind", qualifier: "l1", keyedOnly: true },
    ]);
  });

  it("finds bind chains inside an anonymous module", async () => {
    expect(await factsOf(`class Main {
  void boot() {
    Injector i = Guice.createInjector(new AbstractModule() {
      @Override protected void configure() { bind(Pricing.class).to(DiscountPricing.class); }
    });
  }
}`, "java")).toEqual([{ service: "Pricing", implementation: "DiscountPricing", via: "bind" }]);
  });

  it("reads @ImplementedBy as a default and @Provides methods (a @Named one keyed-only)", async () => {
    expect(await factsOf(`@ImplementedBy(LocalGeo.class)
public interface Geo { String locate(String ip); }
class M extends AbstractModule {
  @Provides Clocky provideClocky() { return new SystemClocky(); }
  @Provides @Named("utc") Clocky utc() { return new UtcClocky(); }
  @Provides @Singleton Clocky viaFactory(ClockFactory f) { return f.make(); }
}`, "java")).toEqual([
      { service: "Geo", implementation: "LocalGeo", via: "@ImplementedBy", ifAbsent: true },
      { service: "Clocky", implementation: "SystemClocky", via: "@Provides" },
      { service: "Clocky", implementation: "UtcClocky", via: "@Provides", qualifier: "utc", keyedOnly: true },
      { service: "Clocky", implementation: "Clocky", via: "@Provides" },
    ]);
  });

  it("reads Kotlin Guice: bind(X::class.java).to(..) and kotlin-guice bind<X>().to<Y>()", async () => {
    expect(await factsOf(`package a
class M : AbstractModule() {
    override fun configure() {
        bind(Pricing::class.java).to(DiscountPricing::class.java)
        bind<Sorter>().annotatedWith(Names.named("fast")).to<QuickSorter>()
    }
}`, "kotlin")).toEqual([
      { service: "Pricing", implementation: "DiscountPricing", via: "bind" },
      { service: "Sorter", implementation: "QuickSorter", via: "bind", qualifier: "fast", keyedOnly: true },
    ]);
  });
});

describe("JVM DI bindings — Dagger / Hilt", () => {
  it("reads @Binds and @Provides, skipping multibindings; a custom qualifier keys the binding", async () => {
    expect(await factsOf(`@Module
public abstract class DataModule {
  @Binds abstract Repo bindRepo(SqlRepo impl);
  @Binds @Fast abstract Repo bindFast(MemRepo impl);
  @Binds @IntoSet abstract Plugin bindPlugin(APlugin impl);
  @Provides static Cachey provideCachey() { return new LruCachey(); }
  @Provides @ActivityScope static Cachey scoped() { return new NoCachey(); }
}`, "java")).toEqual([
      { service: "Repo", implementation: "SqlRepo", via: "@Binds" },
      { service: "Repo", implementation: "MemRepo", via: "@Binds", qualifier: "Fast", keyedOnly: true },
      { service: "Cachey", implementation: "LruCachey", via: "@Provides" },
      { service: "Cachey", implementation: "NoCachey", via: "@Provides" },
    ]);
  });

  it("reads a Hilt module tree-sitter-kotlin would otherwise misparse (two annotations, a following class)", async () => {
    expect(await bindingsOf(`package a

@Module
@InstallIn(SingletonComponent::class)
abstract class CacheModule {
    @Binds
    abstract fun bindCache(impl: DiskCache): Cache

    companion object {
        @Provides @Named("mem") fun mem(): Cache = MemCache()
    }
}

class Unrelated {
    fun x() {}
}
`, "kotlin")).toEqual([
      { service: "Cache", implementation: "DiskCache", line: 6, via: "@Binds" },
      { service: "Cache", implementation: "MemCache", line: 10, via: "@Provides", qualifier: "mem", keyedOnly: true },
    ]);
  });
});

describe("JVM DI bindings — CDI", () => {
  it("binds bean-defining classes by type, named by @Named, an enabled alternative primary", async () => {
    expect(await factsOf(`@ApplicationScoped @Named("primaryBilling")
class CardBilling implements Billing {}
@RequestScoped @Named
class InvoiceBilling implements Billing {}
@ApplicationScoped @Alternative @Priority(1)
class MockShipping implements Shipping {}
@ApplicationScoped @Alternative
class StubShipping implements Shipping {}
@Dependent
class RealShipping implements Shipping {}
@Singleton
class DaggerOnly implements Shipping {}`, "java")).toEqual([
      { service: "Billing", implementation: "CardBilling", via: "@ApplicationScoped", qualifier: "primaryBilling" },
      { service: "Billing", implementation: "InvoiceBilling", via: "@RequestScoped", qualifier: "invoiceBilling" },
      { service: "Shipping", implementation: "MockShipping", via: "@ApplicationScoped", primary: true },
      { service: "Shipping", implementation: "StubShipping", via: "@ApplicationScoped" },
      { service: "Shipping", implementation: "RealShipping", via: "@Dependent" },
    ]);
  });

  it("reads @Produces methods (a @Named producer keeps the default qualifier)", async () => {
    expect(await factsOf(`class Producers {
  @Produces Mailer mailer() { return new SmtpMailer(); }
  @Produces @Named("noop") Mailer noop() { return new NoopMailer(); }
}`, "java")).toEqual([
      { service: "Mailer", implementation: "SmtpMailer", via: "@Produces" },
      { service: "Mailer", implementation: "NoopMailer", via: "@Produces", qualifier: "noop" },
    ]);
  });
});

describe("JVM DI bindings — Koin", () => {
  it("reads module definitions: typed, named, singleOf + bind, infix bind/binds, scopes, forwarding get()", async () => {
    expect(await factsOf(`package a
val appModule = module {
    single { Cfg() }
    single<Mailer> { SmtpMailer(get()) }
    single<Mailer>(named("noop")) { NoopMailer() }
    singleOf(::KafkaBus) { bind<EventBus>() }
    factoryOf(::LocalBus) { bind<EventBus>(); named("local") }
    factory { PdfRenderer() } bind Renderer::class
    single { Multi() } binds arrayOf(A::class, B::class)
    single<Clock> { get<SystemClock>() }
    single<Clock>(named("x")) { makeClock() }
    scope<MainActivity> { scoped<Presenter> { MainPresenter(get()) } }
    single { KRepo() }
}`, "kotlin")).toEqual([
      { service: "Mailer", implementation: "SmtpMailer", via: "single" },
      { service: "Mailer", implementation: "NoopMailer", via: "single", qualifier: "noop", keyedOnly: true },
      { service: "EventBus", implementation: "KafkaBus", via: "singleOf" },
      { service: "EventBus", implementation: "LocalBus", via: "factoryOf", qualifier: "local", keyedOnly: true },
      { service: "Renderer", implementation: "PdfRenderer", via: "factory" },
      { service: "A", implementation: "Multi", via: "single" },
      { service: "B", implementation: "Multi", via: "single" },
      { service: "Clock", implementation: "SystemClock", via: "single" },
      { service: "Clock", implementation: "Clock", via: "single", qualifier: "x", keyedOnly: true },
      { service: "Presenter", implementation: "MainPresenter", via: "scoped" },
    ]);
  });

  it("reads Koin Annotations classes", async () => {
    expect(await factsOf(`package a
@Single
class SmtpMailer : Mailer
@Factory(binds = [Renderer::class])
@Named("pdf")
class PdfRenderer : Renderer, Closeable`, "kotlin")).toEqual([
      { service: "Mailer", implementation: "SmtpMailer", via: "@Single" },
      { service: "Renderer", implementation: "PdfRenderer", via: "@Factory", qualifier: "pdf", keyedOnly: true },
    ]);
  });

  it("ignores a `module` call that is not a Koin module and files with no DI at all", async () => {
    expect(await factsOf(`package a
fun f() { module("x") }
class Plain : Api`, "kotlin")).toEqual([]);
  });
});
