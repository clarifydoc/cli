import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractJsDiBindings } from "./di-bindings.js";
import type { DiBinding } from "../../../types/analysis.js";

/**
 * Container registrations a TS/JS file makes (`FileAnalysis.diBindings`):
 * NestJS/Angular provider objects, Angular `@Injectable` defaults, InversifyJS
 * bind chains and decorators, tsyringe register calls and decorators. Only
 * what the source states: a runtime-choosing factory, a value that is not a
 * construction, a self registration and a `multi` provider yield nothing.
 */
async function bindings(src: string, file = "x.ts"): Promise<DiBinding[]> {
  const tree = await parseSource(src, (file.endsWith(".js") ? "javascript" : "typescript") as any, file);
  return extractJsDiBindings(tree, src, file);
}

/** `service → implementation` plus the flags that matter, for compact assertions. */
const brief = (bs: DiBinding[]) =>
  bs.map((b) => {
    const flags = [
      b.qualifier ? `q=${b.qualifier}` : "",
      b.keyedOnly ? "keyed" : "",
      b.consumer ? `for=${b.consumer}` : "",
      b.ifAbsent ? "ifAbsent" : "",
    ].filter(Boolean);
    return `${b.service} -> ${b.implementation}${flags.length ? ` [${flags.join(",")}]` : ""}`;
  });

describe("NestJS / Angular provider objects", () => {
  it("reads every provider form, wherever the object stands", async () => {
    const bs = await bindings(`
      const notifierProvider = { provide: NOTIFIER, useClass: SmsNotifier };
      const shared = [{ provide: 'SHARED', useClass: SharedImpl }];
      @Module({
        providers: [
          OrdersService,
          { provide: AUDIT_LOG, useClass: DbAuditLog },
          notifierProvider,
          ...shared,
          { provide: CacheStore, useClass: infra.RedisCacheStore },
          { provide: 'LEGACY_MAILER', useExisting: MailerService },
          { provide: TYPES.Alias, useExisting: TYPES.Real },
          { provide: 'ONE', useFactory: (cfg: Config) => new OneImpl(cfg), inject: [Config] },
          { provide: 'BLOCK', useFactory: async () => { const c = await load(); return new BlockImpl(c); } },
          { provide: 'VALUE', useValue: new ValueImpl() },
          { provide: 'EVENTS', useClass: DbAuditLog, multi: true },
          { provide: Same, useClass: Same },
        ],
      })
      export class AppModule {
        static forRoot(): DynamicModule {
          return { module: AppModule, providers: [{ provide: DYN, useClass: DynImpl }] };
        }
      }`);
    expect(brief(bs)).toEqual([
      "NOTIFIER -> SmsNotifier",
      "SHARED -> SharedImpl",
      "AUDIT_LOG -> DbAuditLog",
      "CacheStore -> RedisCacheStore",
      "LEGACY_MAILER -> MailerService",
      "TYPES.Alias -> TYPES.Real",
      "ONE -> OneImpl",
      "BLOCK -> BlockImpl",
      "VALUE -> ValueImpl",
      "DYN -> DynImpl",
    ]);
    expect(bs[0]).toMatchObject({ line: 2, via: "useClass" });
  });

  it("a factory that chooses at runtime, or a plain value, registers nothing", async () => {
    const bs = await bindings(`
      export const providers = [
        { provide: 'PAYMENT', useFactory: (mode: string) => (mode === 'stripe' ? new StripeGateway() : new PaypalGateway()) },
        { provide: 'BRANCHY', useFactory: () => { if (x) { return new A(); } return new B(); } },
        { provide: 'BY_REF', useFactory: makeGateway },
        { provide: 'PAY_MODE', useValue: 'stripe' },
        { provide: 'CFG', useValue: { region: 'eu' } },
      ];`);
    expect(bs).toEqual([]);
  });

  it("emits both of two disagreeing registrations (the linker refuses to choose)", async () => {
    const bs = await bindings(`
      export const appConfig: ApplicationConfig = { providers: [{ provide: Logger, useClass: RemoteLogger }] };
      @Component({ selector: 'x', providers: [{ provide: Logger, useClass: ConsoleLogger }] })
      export class X {}
      bootstrapApplication(AppComponent, { providers: [{ provide: ANALYTICS, useClass: GaAnalytics }] });
      export const env = makeEnvironmentProviders([{ provide: FORMATTER, useExisting: DateFormatter }]);`);
    expect(brief(bs)).toEqual([
      "Logger -> RemoteLogger",
      "Logger -> ConsoleLogger",
      "ANALYTICS -> GaAnalytics",
      "FORMATTER -> DateFormatter",
    ]);
  });

  it("an Angular @Injectable({ providedIn, useClass }) is a default for the decorated token class", async () => {
    const bs = await bindings(`
      @Injectable({ providedIn: 'root', useClass: ConsoleClock })
      export abstract class Clock { abstract now(): number; }
      @Injectable({ providedIn: 'root' })
      export class Plain {}`);
    expect(brief(bs)).toEqual(["Clock -> ConsoleClock [ifAbsent]"]);
    expect(bs[0]!.via).toBe("@Injectable/useClass");
  });

  it("ignores files without any registration and objects that are not providers", async () => {
    expect(await bindings(`export const x = { provide: 'theme' }; foo.bind(this); app.register(plugin, { prefix: '/api' });`)).toEqual([]);
    expect(await bindings(`export default { provide: { theme: 'dark' }, data() { return {}; } };`)).toEqual([]);
  });
});

describe("InversifyJS", () => {
  it("reads bind chains: to, scopes, names, tags, contextual, aliases, values, factories", async () => {
    const bs = await bindings(`
      const container = new Container();
      container.bind<IUserRepo>(TYPES.UserRepo).to(SqlUserRepo);
      container.bind<IMailer>(TYPES.Mailer).to(SmtpMailer).inSingletonScope();
      container.bind<ILogger>(TYPES.Logger).to(FileLogger).whenTargetNamed('file');
      container.bind<ILogger>(TYPES.Logger).to(ConsoleLogger).whenTargetNamed('console');
      container.bind(TYPES.Weapon).to(Shuriken).whenTargetTagged('canThrow', true);
      container.bind<IAudit>(TYPES.Audit).to(SpecialAudit).whenInjectedInto(OrderService);
      container.bind<IParser>(TYPES.Parser).toDynamicValue(() => new JsonParser());
      container.bind<IParser>(TYPES.Parser2).toDynamicValue((ctx) => ctx.container.get(TYPES.Parser));
      container.bind(TYPES.Cfg).toConstantValue(new Config());
      container.bind(TYPES.Raw).toConstantValue(rawValue);
      container.bind(TYPES.Old).toService(TYPES.UserRepo);
      container.bind(Clock).toSelf().inSingletonScope();
      container.bind(Clock).toSelf().whenTargetNamed('wall');
      container.rebind<IMailer>(TYPES.Mailer).to(OtherMailer);
      export const mod = new ContainerModule((bind) => { bind<INotifier>(TYPES.Notifier).to(PushNotifier); });
      handler.bind(this);`);
    expect(brief(bs)).toEqual([
      "TYPES.UserRepo -> SqlUserRepo",
      "TYPES.Mailer -> SmtpMailer",
      "TYPES.Logger -> FileLogger [q=file,keyed]",
      // A named registration is also recorded under its type argument, keyed
      // by the name — how an `@inject(TYPES.Logger) @named('file') l: ILogger`
      // point (qualifier `file`) meets it.
      "ILogger -> FileLogger [q=file,keyed]",
      "TYPES.Logger -> ConsoleLogger [q=console,keyed]",
      "ILogger -> ConsoleLogger [q=console,keyed]",
      "TYPES.Weapon -> Shuriken [q=canThrow=true,keyed]",
      "TYPES.Audit -> SpecialAudit [for=OrderService]",
      "TYPES.Parser -> JsonParser",
      "TYPES.Cfg -> Config",
      "TYPES.Old -> TYPES.UserRepo",
      "Clock -> Clock [q=wall,keyed]",
      "TYPES.Mailer -> OtherMailer",
      "TYPES.Notifier -> PushNotifier",
    ]);
    expect(bs.find((b) => b.implementation === "OtherMailer")!.via).toBe("rebind.to");
  });

  it("reads @provide class decorators", async () => {
    const bs = await bindings(`
      @provide(TYPES.Warrior)
      export class Ninja implements Warrior {}
      @provide(Samurai)
      class Samurai {}`);
    expect(brief(bs)).toEqual(["TYPES.Warrior -> Ninja"]);
  });
});

describe("tsyringe", () => {
  it("reads register-family calls and registration decorators", async () => {
    const bs = await bindings(`
      container.register<IAccountRepo>('IAccountRepo', { useClass: PgAccountRepo });
      container.registerSingleton<IEmailer>('IEmailer', SesEmailer);
      container.register('ChatNotifier', { useClass: SlackNotifier }, { lifecycle: Lifecycle.Singleton });
      container.register(AuditTrail, { useClass: DbAuditTrail });
      container.register(SystemClock, { useClass: SystemClock });
      container.register('Config', { useValue: { region: 'eu' } });
      container.register('Emailer2', { useToken: 'IEmailer' });
      container.register('Repo2', { useFactory: (c) => c.resolve<IAccountRepo>('IAccountRepo') });
      container.register('Repo3', { useFactory: instanceCachingFactory((c) => new MongoAccountRepo()) });
      container.registerType('IFoo', FooImpl);
      container.registerInstance('Now', Date.now());
      container.registerInstance('Clock', new FixedClock());
      container.registerSingleton(Standalone);
      register('Free', { useClass: NotTsyringe });

      @registry([{ token: 'IBar', useClass: BarImpl }, { token: Baz, useFactory: () => new BazImpl() }])
      class Registrations {}
      @injectable({ token: 'IQux' })
      export class QuxImpl {}`);
    expect(brief(bs)).toEqual([
      "IAccountRepo -> PgAccountRepo",
      "IEmailer -> SesEmailer",
      "ChatNotifier -> SlackNotifier",
      "AuditTrail -> DbAuditTrail",
      "Emailer2 -> IEmailer",
      "Repo3 -> MongoAccountRepo",
      "IFoo -> FooImpl",
      "Clock -> FixedClock",
      "IBar -> BarImpl",
      "Baz -> BazImpl",
      "IQux -> QuxImpl",
    ]);
    expect(bs.map((b) => b.via)).toEqual([
      "register/useClass",
      "registerSingleton",
      "register/useClass",
      "register/useClass",
      "register/useToken",
      "register/useFactory",
      "registerType",
      "registerInstance",
      "@registry",
      "@registry",
      "@injectable",
    ]);
  });
});
