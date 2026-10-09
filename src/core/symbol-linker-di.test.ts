import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, DiBinding, FileAnalysis, ParamInfo, PropertyInfo } from "../types/analysis.js";

/**
 * Dependency-injection resolution in the linker: calls through injected
 * members, container registrations, typed receivers on name-classified calls,
 * and the interface map keyed by definition. Language-agnostic — the
 * analyses below are hand-built, as a plugin would emit them.
 */

const call = (name: string, extra: Partial<CallInfo> = {}): CallInfo =>
  ({ name, kind: "internal", target: null, line: 10, ...extra });

const method = (name: string, calls: CallInfo[] = [], params: ParamInfo[] = [], line = 5) =>
  ({ name, line, endLine: line + 3, params, calls, returnType: null as string | null, isAsync: false, isExported: true, decorators: [] });

const prop = (name: string, type: string, extra: Partial<PropertyInfo> = {}): PropertyInfo =>
  ({ name, type, visibility: "private", isStatic: false, isReadonly: true, ...extra });

const param = (name: string, type: string | null, extra: Partial<ParamInfo> = {}): ParamInfo =>
  ({ name, type, defaultValue: null, ...extra });

interface ClsOpts {
  kind?: "class" | "interface";
  extends?: string | null;
  implements?: string[];
  methods?: ReturnType<typeof method>[];
  properties?: PropertyInfo[];
}
const cls = (name: string, o: ClsOpts = {}): {
  name: string; kind: "class" | "interface"; extends: string | null; implements: string[];
  methods: ReturnType<typeof method>[]; properties: PropertyInfo[]; decorators: string[];
  isExported: boolean; line: number; endLine: number; structural?: boolean;
} => ({
  name,
  kind: o.kind ?? "class",
  extends: o.extends ?? null,
  implements: o.implements ?? [],
  methods: o.methods ?? [],
  properties: o.properties ?? [],
  decorators: [],
  isExported: true,
  line: 1,
  endLine: 30,
});

const file = (
  filePath: string,
  classes: ReturnType<typeof cls>[],
  extra: { projectId?: string; diBindings?: DiBinding[]; language?: string; functions?: unknown[] } = {},
): FileAnalysis =>
  ({
    filePath,
    projectId: extra.projectId ?? "root",
    language: extra.language ?? "csharp",
    functions: extra.functions ?? [],
    classes,
    imports: [],
    exports: [],
    routes: [],
    dataSources: [],
    ...(extra.diBindings ? { diBindings: extra.diBindings } : {}),
  } as unknown as FileAnalysis);

const bind = (service: string, implementation: string, extra: Partial<DiBinding> = {}): DiBinding =>
  ({ service, implementation, line: 3, via: "test", ...extra });

/** Two implementations of INotifier, both defining Send. */
const notifiers = (): FileAnalysis[] => [
  file("Domain/INotifier.cs", [cls("INotifier", { kind: "interface", methods: [method("Send", [], [], 3)] })]),
  file("Infra/Mail/MailNotifier.cs", [cls("MailNotifier", { implements: ["INotifier"], methods: [method("Send", [], [], 7)] })]),
  file("Infra/Sms/SmsNotifier.cs", [cls("SmsNotifier", { implements: ["INotifier"], methods: [method("Send", [], [], 9)] })]),
];

const consumer = (
  path: string,
  calls: CallInfo[],
  props: PropertyInfo[] = [prop("_notifier", "INotifier")],
  extra: Parameters<typeof file>[2] = {},
) => file(path, [cls("OrderService", { properties: props, methods: [method("Place", calls)] })], extra);

const callsFrom = (links: ReturnType<typeof buildSymbolLinks>, sourceFile: string) =>
  links.filter((l) => l.sourceFile === sourceFile && l.relation !== "reference");

describe("symbol-linker — dependency injection", () => {
  it("stays on the interface when two implementations exist and nothing binds one", () => {
    const links = buildSymbolLinks([...notifiers(), consumer("Infra/Mail/OrderService.cs", [call("_notifier.Send")])]);
    const out = callsFrom(links, "Infra/Mail/OrderService.cs");
    // No guessing by directory proximity: MailNotifier shares the caller's dir.
    expect(out.map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);
    expect(out[0]!.strategy).toBe("injection");
  });

  it("follows a container registration to the bound implementation", () => {
    const program = file("Api/Program.cs", [], { diBindings: [bind("INotifier", "SmsNotifier")] });
    const links = buildSymbolLinks([...notifiers(), program, consumer("Infra/Mail/OrderService.cs", [call("_notifier.Send")])]);
    const out = callsFrom(links, "Infra/Mail/OrderService.cs");
    expect(out.map((l) => [l.targetSymbol, l.strategy])).toEqual([["SmsNotifier.Send", "di-binding"]]);
    // …and records that the caller depends on the interface's signature.
    const ref = links.find((l) => l.sourceFile === "Infra/Mail/OrderService.cs" && l.relation === "reference");
    expect(ref?.targetSymbol).toBe("INotifier.Send");
  });

  it("does not choose when two unconditional registrations disagree", () => {
    const program = file("Api/Program.cs", [], { diBindings: [bind("INotifier", "SmsNotifier"), bind("INotifier", "MailNotifier")] });
    const links = buildSymbolLinks([...notifiers(), program, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs").map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);
  });

  it("prefers a primary registration, then one named like the injected member", () => {
    const primary = file("Api/Config.cs", [], {
      diBindings: [bind("INotifier", "SmsNotifier", { primary: true }), bind("INotifier", "MailNotifier")],
    });
    let links = buildSymbolLinks([...notifiers(), primary, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("SmsNotifier.Send");

    const byName = file("Api/Config.cs", [], {
      diBindings: [
        bind("INotifier", "SmsNotifier", { qualifier: "smsNotifier", matchesMemberName: true }),
        bind("INotifier", "MailNotifier", { qualifier: "mailNotifier", matchesMemberName: true }),
      ],
    });
    links = buildSymbolLinks([
      ...notifiers(),
      byName,
      consumer("App/OrderService.cs", [call("mailNotifier.Send")], [prop("mailNotifier", "INotifier")]),
    ]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("MailNotifier.Send");
  });

  it("selects by qualifier, and keeps keyed-only registrations away from unqualified injection", () => {
    const keyed = file("Api/Program.cs", [], {
      diBindings: [bind("INotifier", "SmsNotifier", { qualifier: "sms", keyedOnly: true })],
    });
    let links = buildSymbolLinks([
      ...notifiers(),
      keyed,
      consumer("App/OrderService.cs", [call("_notifier.Send")], [prop("_notifier", "INotifier", { qualifier: "sms" })]),
    ]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("SmsNotifier.Send");

    links = buildSymbolLinks([...notifiers(), keyed, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("INotifier.Send");
  });

  it("resolves a token injection point through the token's registration", () => {
    const module = file("src/app.module.ts", [], { language: "typescript", diBindings: [bind("NOTIFIER", "SmsNotifier")] });
    const ts = notifiers().map((a) => ({ ...a, filePath: a.filePath.replace(/\.cs$/, ".ts"), language: "typescript" }) as FileAnalysis);
    const svc = consumer("src/order.service.ts", [call("this._notifier.Send")], [prop("_notifier", "INotifier", { qualifier: "NOTIFIER" })], { language: "typescript" });
    const links = buildSymbolLinks([...ts, module, svc]);
    expect(callsFrom(links, "src/order.service.ts")[0]!.targetSymbol).toBe("SmsNotifier.Send");
  });

  it("resolves a member injected by key alone (no declared type) through its registration", () => {
    const container = file("config/container.rb", [], { language: "ruby", diBindings: [bind("repos.user", "SqlNotifier", { keyedOnly: true })] });
    const impl = file("app/sql_notifier.rb", [cls("SqlNotifier", { methods: [method("Send", [], [], 3)] })], { language: "ruby" });
    const svc = file("app/order_service.rb", [cls("OrderService", {
      properties: [{ name: "user", type: null, visibility: "private", isStatic: false, isReadonly: true, qualifier: "repos.user" }],
      methods: [method("place", [call("user.Send")])],
    })], { language: "ruby" });
    const links = buildSymbolLinks([container, impl, svc]);
    expect(callsFrom(links, "app/order_service.rb")[0]).toMatchObject({ targetSymbol: "SqlNotifier.Send", strategy: "di-binding" });
  });

  it("applies a contextual registration only to its consumer", () => {
    const provider = file("app/Providers/AppServiceProvider.php", [], {
      language: "php",
      diBindings: [bind("INotifier", "MailNotifier"), bind("INotifier", "SmsNotifier", { consumer: "OrderService" })],
    });
    const php = notifiers().map((a) => ({ ...a, filePath: a.filePath.replace(/\.cs$/, ".php"), language: "php" }) as FileAnalysis);
    const order = consumer("app/OrderService.php", [call("this._notifier.Send")], undefined, { language: "php" });
    const other = file("app/Billing.php", [cls("Billing", { properties: [prop("_notifier", "INotifier")], methods: [method("Bill", [call("this._notifier.Send")])] })], { language: "php" });
    const links = buildSymbolLinks([...php, provider, order, other]);
    expect(callsFrom(links, "app/OrderService.php")[0]!.targetSymbol).toBe("SmsNotifier.Send");
    expect(callsFrom(links, "app/Billing.php")[0]!.targetSymbol).toBe("MailNotifier.Send");
  });

  it("never injects a class into itself (a decorator's inner dependency)", () => {
    const program = file("Api/Program.cs", [], { diBindings: [bind("INotifier", "LoggingNotifier")] });
    const decorator = file("Infra/LoggingNotifier.cs", [cls("LoggingNotifier", {
      implements: ["INotifier"],
      properties: [prop("_inner", "INotifier")],
      methods: [method("Send", [call("_inner.Send")], [], 6)],
    })]);
    const links = buildSymbolLinks([...notifiers(), decorator, program]);
    const out = links.filter((l) => l.sourceFile === "Infra/LoggingNotifier.cs" && l.relation !== "reference");
    expect(out.map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);

    // …nor to ANOTHER app's registration of the same interface.
    const otherApp = file("Other/Program.cs", [], { projectId: "Other", diBindings: [bind("INotifier", "SmsNotifier")] });
    const ownApp = file("Infra/Program.cs", [], { diBindings: [bind("INotifier", "LoggingNotifier")] });
    const links2 = buildSymbolLinks([...notifiers(), decorator, ownApp, otherApp]);
    const out2 = links2.filter((l) => l.sourceFile === "Infra/LoggingNotifier.cs" && l.relation !== "reference");
    expect(out2.map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);
  });

  it("matches a registration to the interface DEFINITION it names, not just its name", () => {
    // Two packages each declare IAppService with their own @Service AppService
    // (a Spring stereotype binding: service = the implemented interface's name).
    const kt = (path: string, classes: ReturnType<typeof cls>[], diBindings?: DiBinding[]) =>
      file(path, classes, { language: "kotlin", ...(diBindings ? { diBindings } : {}) });
    const appIface = kt("app/IAppService.kt", [cls("IAppService", { kind: "interface", methods: [method("run")] })]);
    const appImpl = kt("app/AppService.kt", [cls("AppService", { implements: ["IAppService"], methods: [method("run", [], [], 4)] })],
      [bind("IAppService", "AppService", { qualifier: "appService", matchesMemberName: true })]);
    const mobIface = kt("mobileapp/functions/IAppService.kt", [cls("IAppService", { kind: "interface", methods: [method("run")] })]);
    const mobImpl = kt("mobileapp/functions/AppService.kt", [cls("AppService", { implements: ["IAppService"], methods: [method("run", [], [], 6)] })],
      [bind("IAppService", "AppService", { qualifier: "appService", matchesMemberName: true })]);
    const ctrl = kt("mobileapp/view/AppController.kt", [cls("AppController", { properties: [prop("service", "IAppService")], methods: [method("go", [call("this.service.run")])] })]);
    const out = callsFrom(buildSymbolLinks([appIface, appImpl, mobIface, mobImpl, ctrl]), "mobileapp/view/AppController.kt");
    expect(out[0]).toMatchObject({ targetFile: "mobileapp/functions/AppService.kt", targetSymbol: "AppService.run" });
  });

  it("does not count two different classes of one name as agreeing registrations", () => {
    const a = file("a/SmsNotifier.cs", [cls("SmsNotifier", { implements: ["INotifier"], methods: [method("Send", [], [], 3)] })]);
    const b = file("b/SmsNotifier.cs", [cls("SmsNotifier", { implements: ["INotifier"], methods: [method("Send", [], [], 3)] })]);
    const iface = file("Domain/INotifier.cs", [cls("INotifier", { kind: "interface", methods: [method("Send")] })]);
    const regA = file("a/Program.cs", [], { diBindings: [bind("INotifier", "SmsNotifier")] });
    const regB = file("b/Program.cs", [], { diBindings: [bind("INotifier", "SmsNotifier")] });
    const out = callsFrom(buildSymbolLinks([iface, a, b, regA, regB, consumer("App/OrderService.cs", [call("_notifier.Send")])]), "App/OrderService.cs");
    expect(out.map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);
  });

  it("applies registrations to injected parameters, never to an ordinary method parameter", () => {
    const program = file("Api/Program.cs", [], { diBindings: [bind("INotifier", "SmsNotifier")] });
    const svc = file("App/Svc.cs", [cls("Svc", {
      methods: [
        method("Plain", [call("n.Send")], [param("n", "INotifier")]),
        method("Action", [call("m.Send")], [param("m", "INotifier", { injected: true })]),
      ],
    })]);
    const out = callsFrom(buildSymbolLinks([...notifiers(), program, svc]), "App/Svc.cs");
    expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([
      ["n.Send", "INotifier.Send"],
      ["m.Send", "SmsNotifier.Send"],
    ]);
  });

  it("ignores a test container's registrations for production code", () => {
    const testSetup = file("tests/TestStartup.cs", [], { diBindings: [bind("INotifier", "SmsNotifier")] });
    const links = buildSymbolLinks([...notifiers(), testSetup, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("INotifier.Send");
  });

  it("prefers the consumer's own sub-project container, and needs agreement across others", () => {
    const apiA = file("A/Program.cs", [], { projectId: "A", diBindings: [bind("INotifier", "SmsNotifier")] });
    const apiB = file("B/Program.cs", [], { projectId: "B", diBindings: [bind("INotifier", "MailNotifier")] });
    const inA = consumer("A/OrderService.cs", [call("_notifier.Send")], undefined, { projectId: "A" });
    const inC = consumer("C/OrderService.cs", [call("_notifier.Send")], undefined, { projectId: "C" });
    const links = buildSymbolLinks([...notifiers(), apiA, apiB, inA, inC]);
    expect(callsFrom(links, "A/OrderService.cs")[0]!.targetSymbol).toBe("SmsNotifier.Send");
    expect(callsFrom(links, "C/OrderService.cs")[0]!.targetSymbol).toBe("INotifier.Send");
  });

  it("follows an alias registration to the class it ends at", () => {
    const program = file("Api/Program.cs", [], {
      diBindings: [bind("ILegacyNotifier", "INotifier"), bind("INotifier", "SmsNotifier")],
    });
    const legacy = file("Domain/ILegacyNotifier.cs", [cls("ILegacyNotifier", { kind: "interface", methods: [method("Send")] })]);
    const links = buildSymbolLinks([
      ...notifiers(),
      legacy,
      program,
      consumer("App/OrderService.cs", [call("_old.Send")], [prop("_old", "ILegacyNotifier")]),
    ]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("SmsNotifier.Send");
  });

  it("lets a real registration override a default (TryAdd / @ImplementedBy) in any order", () => {
    for (const order of [["try", "add"], ["add", "try"]]) {
      const bindings = order.map((k) =>
        k === "try" ? bind("INotifier", "MailNotifier", { ifAbsent: true }) : bind("INotifier", "SmsNotifier"));
      const program = file("Api/Program.cs", [], { diBindings: bindings });
      const links = buildSymbolLinks([...notifiers(), program, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
      expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol, order.join(",")).toBe("SmsNotifier.Send");
    }
  });

  it("resolves a registration naming a provider function through its declared result", () => {
    const go = (path: string, classes: ReturnType<typeof cls>[], functions: unknown[] = [], diBindings?: DiBinding[]) =>
      file(path, classes, { language: "go", functions, ...(diBindings ? { diBindings } : {}) });
    const ctor = (name: string, returnType: string) => ({ ...method(name), returnType });
    const iface = go("repo/repo.go", [{ ...cls("UserRepo", { kind: "interface", methods: [method("Find")] }), structural: true }]);
    const pg = go("repo/pg.go", [cls("PgRepo", { methods: [method("Find", [], [], 9)] })], [ctor("NewPgRepo", "*PgRepo"), ctor("NewAny", "UserRepo")]);
    const mem = go("repo/mem.go", [cls("MemRepo", { methods: [method("Find", [], [], 4)] })]);
    const svc = go("svc/svc.go", [cls("Svc", { properties: [prop("repo", "UserRepo")], methods: [method("Get", [call("repo.Find")])] })]);
    const app = (impl: string) => go("repo/module.go", [], [], [bind("UserRepo", impl)]);
    expect(callsFrom(buildSymbolLinks([iface, pg, mem, svc, app("NewPgRepo")]), "svc/svc.go")[0]!.targetSymbol).toBe("PgRepo.Find");
    // A provider declared to return the interface decides nothing.
    expect(callsFrom(buildSymbolLinks([iface, pg, mem, svc, app("NewAny")]), "svc/svc.go")[0]!.targetSymbol).toBe("UserRepo.Find");
  });

  it("expands an all-interfaces registration from the class's own declaration", () => {
    const sink = file("Infra/SlackSink.cs", [cls("SlackSink", { extends: "BaseSink", implements: ["INotifier", "IDisposable"], methods: [method("Send", [], [], 5)] })]);
    const base = file("Infra/BaseSink.cs", [cls("BaseSink")]);
    const module = file("Api/Module.cs", [], { diBindings: [{ service: "", implementation: "SlackSink", allInterfaces: true, line: 2, via: "test" }] });
    const links = buildSymbolLinks([...notifiers(), sink, base, module, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs")[0]).toMatchObject({ targetSymbol: "SlackSink.Send", strategy: "di-binding" });
  });

  it("resolves an extension method on a typed receiver — same file or not", () => {
    const kt = (path: string, classes: ReturnType<typeof cls>[], functions: unknown[] = []) => file(path, classes, { language: "kotlin", functions });
    const ext = { ...method("addRow", [], [{ name: "this", type: "Band", defaultValue: null, isReceiver: true }], 12), name: "addRow" };
    const band = kt("ui/Band.kt", [cls("Band"), cls("FooterBand", { extends: "Band" })]);
    const report = kt("ui/Report.kt", [cls("Report", {
      properties: [prop("footer", "FooterBand")],
      methods: [method("build", [call("footer.addRow")])],
    })], [ext]);
    const out = callsFrom(buildSymbolLinks([band, report]), "ui/Report.kt");
    expect(out.map((l) => l.targetSymbol)).toContain("addRow");
  });

  it("reaches a method the implementation inherits from its base class", () => {
    const base = file("Infra/BaseNotifier.cs", [cls("BaseNotifier", { methods: [method("Send", [], [], 4)] })]);
    const impl = file("Infra/QueueNotifier.cs", [cls("QueueNotifier", { extends: "BaseNotifier", implements: ["INotifier"] })]);
    const iface = file("Domain/INotifier.cs", [cls("INotifier", { kind: "interface", methods: [method("Send")] })]);
    const links = buildSymbolLinks([base, impl, iface, consumer("App/OrderService.cs", [call("_notifier.Send")])]);
    expect(callsFrom(links, "App/OrderService.cs")[0]!.targetSymbol).toBe("BaseNotifier.Send");
  });
});

describe("symbol-linker — typed receivers", () => {
  const repo = () =>
    file("Data/UserRepository.php", [cls("UserRepository", { methods: [method("find", [], [], 6), method("save", [], [], 9)] })], { language: "php" });

  it("links a name-classified database call when its receiver is an injected project class", () => {
    const svc = file("Service/UserService.php", [cls("UserService", {
      methods: [method("create", [call("repo.save", { kind: "database" })], [param("repo", "UserRepository")])],
    })], { language: "php" });
    const links = buildSymbolLinks([repo(), svc]);
    expect(callsFrom(links, "Service/UserService.php").map((l) => l.targetSymbol)).toEqual(["UserRepository.save"]);
  });

  it("leaves a database call alone when the declared type does not define the method", () => {
    const svc = file("Service/UserService.php", [cls("UserService", {
      methods: [method("create", [call("repo.persist", { kind: "database" })], [param("repo", "UserRepository")])],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), svc]), "Service/UserService.php")).toEqual([]);
  });

  it("scopes a bare receiver as local, then parameter, then field", () => {
    const other = file("Data/AuditLog.php", [cls("AuditLog", { methods: [method("find", [], [], 3)] })], { language: "php" });
    const svc = file("Service/UserService.php", [cls("UserService", {
      properties: [prop("repo", "AuditLog")],
      methods: [method("load", [call("repo.find")], [param("repo", "UserRepository")])],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), other, svc]), "Service/UserService.php")[0]!.targetSymbol).toBe("UserRepository.find");
  });

  it("never reads a bare receiver as a field where fields need `this.`", () => {
    const repoTs = file("src/repo.ts", [cls("UserRepo", { methods: [method("load", [], [], 3)] })], { language: "typescript" });
    // A second `load`, so the unique-name heuristic cannot link the bare call.
    const decoy = file("src/other.ts", [cls("Other", { methods: [method("load", [], [], 2)] })], { language: "typescript" });
    const svc = file("src/svc.ts", [cls("Svc", {
      properties: [prop("repo", "UserRepo")],
      methods: [method("run", [call("repo.load"), call("this.repo.load")])],
    })], { language: "typescript" });
    const out = callsFrom(buildSymbolLinks([repoTs, decoy, svc]), "src/svc.ts");
    expect(out.map((l) => l.callName)).toEqual(["this.repo.load"]);
  });

  it("does not let a sibling class's field type a receiver", () => {
    const svc = file("Service/Both.php", [
      cls("A", { properties: [prop("repo", "UserRepository")] }),
      cls("B", { methods: [method("run", [call("this.repo.find")])] }),
    ], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), svc]), "Service/Both.php")).toEqual([]);
  });

  it("follows `self.x` and member chains through declared field types", () => {
    const holder = file("Service/Holder.py", [cls("Holder", { properties: [prop("repo", "Optional[UserRepository]")] })], { language: "python" });
    const repoPy = file("Data/repo.py", [cls("UserRepository", { methods: [method("find", [], [], 6)] })], { language: "python" });
    const svc = file("Service/svc.py", [cls("Svc", {
      properties: [prop("holder", "Holder")],
      methods: [method("run", [call("self.holder.repo.find")])],
    })], { language: "python" });
    const links = buildSymbolLinks([repoPy, holder, svc]);
    expect(callsFrom(links, "Service/svc.py")[0]!.targetSymbol).toBe("UserRepository.find");
  });

  it("normalizes optional chaining and non-null assertions on the receiver", () => {
    const svc = file("Service/UserService.php", [cls("UserService", {
      properties: [prop("repo", "?UserRepository")],
      methods: [method("a", [call("this.repo?.find"), call("this.repo!!.save")])],
    })], { language: "php" });
    const targets = callsFrom(buildSymbolLinks([repo(), svc]), "Service/UserService.php").map((l) => l.targetSymbol).sort();
    expect(targets).toEqual(["UserRepository.find", "UserRepository.save"]);
  });

  it("resolves an inline service-locator receiver from CallInfo.receiverType", () => {
    const svc = file("Service/UserService.php", [cls("UserService", {
      methods: [method("a", [call("app(UserRepository::class).find", { receiverType: "UserRepository" })])],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), svc]), "Service/UserService.php")[0]!.targetSymbol).toBe("UserRepository.find");
  });

  describe("call chains through declared return types", () => {
    const returning = (name: string, returnType: string | null, line = 5, calls: CallInfo[] = []) =>
      ({ ...method(name, calls, [], line), returnType });
    const domain = () => [
      file("app/Choice.java", [cls("Choice", { methods: [returning("getTheCase", "Case", 4), returning("getOwner", "Optional<Person>", 8)] })], { language: "java" }),
      file("app/Case.java", [cls("Case", { methods: [returning("getCaseState", "CaseState", 6), returning("getId", "Long", 9)] })], { language: "java" }),
      file("app/Person.java", [cls("Person", { methods: [returning("getName", "String", 3)] })], { language: "java" }),
    ];
    const caller = (calls: CallInfo[], extra: { methods?: ReturnType<typeof method>[]; params?: ParamInfo[] } = {}) =>
      file("web/Action.java", [cls("Action", {
        methods: [{ ...method("run", calls, extra.params ?? [param("choice", "Choice")]) }, ...(extra.methods ?? [])],
      })], { language: "java" });

    it("follows a getter chain hop by hop", () => {
      const links = buildSymbolLinks([...domain(), caller([call("choice.getTheCase().getCaseState")])]);
      expect(callsFrom(links, "web/Action.java").map((l) => [l.targetSymbol, l.strategy])).toEqual([["Case.getCaseState", "injection"]]);
    });

    it("keeps arguments that contain dots inside their call", () => {
      const links = buildSymbolLinks([...domain(), caller([call("choice.getTheCase( other.getX().y ).getId")])]);
      expect(callsFrom(links, "web/Action.java").map((l) => l.targetSymbol)).toEqual(["Case.getId"]);
    });

    it("starts from the enclosing class's own method", () => {
      const links = buildSymbolLinks([...domain(), caller([call("root().getId"), call("this.root().getId")], { methods: [returning("root", "Case", 20)] })]);
      expect(callsFrom(links, "web/Action.java").map((l) => l.targetSymbol)).toEqual(["Case.getId", "Case.getId"]);
    });

    it("starts from a constructed instance", () => {
      const links = buildSymbolLinks([...domain(), caller([call("new Case(a.b).getId"), call("new app.Case().getCaseState")])]);
      expect(callsFrom(links, "web/Action.java").map((l) => l.targetSymbol)).toEqual(["Case.getId", "Case.getCaseState"]);
    });

    it("stays on the receiver's class through a fluent `$this` / `static` return", () => {
      const sheet = file("lib/Worksheet.php", [cls("Worksheet", { methods: [returning("setTitle", "$this", 4), returning("getCell", "Cell", 8)] })], { language: "php" });
      const cell = file("lib/Cell.php", [cls("Cell", { methods: [returning("setValue", null, 3)] })], { language: "php" });
      const book = file("lib/Workbook.php", [cls("Workbook", { methods: [returning("getActiveSheet", "Worksheet|false", 5), returning("getInstance", "static", 9)] })], { language: "php" });
      const svc = file("app/Export.php", [cls("Export", {
        methods: [{ ...method("run", [
          call("book.getActiveSheet().setTitle('x').getCell('A1').setValue"),
          call("Workbook::getInstance().getActiveSheet().getCell"),
        ]), localTypes: [{ name: "book", type: "Workbook" }] } as ReturnType<typeof method>],
      })], { language: "php" });
      const out = callsFrom(buildSymbolLinks([sheet, cell, book, svc]), "app/Export.php");
      expect(out.map((l) => l.targetSymbol)).toEqual(["Cell.setValue", "Worksheet.getCell"]);
    });

    it("types a local by what its initializer call is declared to return", () => {
      const withLocals = (calls: CallInfo[], localTypes: unknown[]) =>
        file("web/Action.java", [cls("Action", {
          methods: [{ ...method("run", calls, [param("choice", "Choice")]), localTypes } as ReturnType<typeof method>],
        })], { language: "java" });
      const links = buildSymbolLinks([...domain(), withLocals(
        [call("theCase.getCaseState"), call("again.getId"), call("loop.getId")],
        [
          { name: "theCase", type: "", from: "choice.getTheCase()" },
          // A local initialized from another such local.
          { name: "again", type: "", from: "theCase.self()" },
          { name: "loop", type: "", from: "loop.next()" },
        ],
      ), file("app/Decoy.java", [cls("Decoy", { methods: [returning("getId", "Long", 3)] })], { language: "java" })]);
      const out = callsFrom(links, "web/Action.java");
      expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([["theCase.getCaseState", "Case.getCaseState"]]);
    });

    it("types a local initialized in several branches only when every call returns the same class", () => {
      const sheet = file("lib/Sheet.php", [cls("Sheet", { methods: [
        returning("getCell", "Cell", 3), returning("getCellAt", "Cell", 5), returning("createRun", "Run", 7),
      ] })], { language: "php" });
      const cellCls = file("lib/Cell.php", [cls("Cell", { methods: [returning("getFont", null, 3)] })], { language: "php" });
      const run = file("lib/Run.php", [cls("Run", { methods: [returning("getFont", null, 3)] })], { language: "php" });
      const svc = file("app/Export.php", [cls("Export", {
        properties: [prop("sheet", "Sheet")],
        methods: [{ ...method("run", [call("a.getFont"), call("b.getFont")]), localTypes: [
          { name: "a", type: "", from: "this.sheet.getCell()" },
          { name: "a", type: "", from: "this.sheet.getCellAt()" },
          { name: "b", type: "", from: "this.sheet.getCell()" },
          { name: "b", type: "", from: "this.sheet.createRun()" },
        ] } as ReturnType<typeof method>],
      })], { language: "php" });
      const out = callsFrom(buildSymbolLinks([sheet, cellCls, run, svc]), "app/Export.php");
      expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([["a.getFont", "Cell.getFont"]]);
    });

    it("unwraps the language's task type when the initializer is awaited", () => {
      const repo = file("Data/Repo.cs", [cls("Repo", { methods: [returning("FindAsync", "Task<User>", 3), returning("Find", "User", 6)] })]);
      const user = file("Domain/User.cs", [cls("User", { methods: [returning("Rename", null, 4)] })]);
      const svc = file("App/Svc.cs", [cls("Svc", {
        properties: [prop("_repo", "Repo")],
        methods: [{ ...method("Run", [call("a.Rename"), call("b.Rename"), call("c.Rename")]), localTypes: [
          { name: "a", type: "", from: "_repo.FindAsync()", awaited: true },
          { name: "b", type: "", from: "_repo.Find()" },
          // Not awaited: the local holds the Task itself.
          { name: "c", type: "", from: "_repo.FindAsync()" },
        ] } as ReturnType<typeof method>],
      })]);
      const decoy = file("Domain/Group.cs", [cls("Group", { methods: [returning("Rename", null, 4)] })]);
      const out = callsFrom(buildSymbolLinks([repo, user, decoy, svc]), "App/Svc.cs");
      expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([["a.Rename", "User.Rename"], ["b.Rename", "User.Rename"]]);
    });

    it("keeps a reassigned parameter's declared type when the reassigning call states none", () => {
      const svc = file("web/Action.java", [cls("Action", {
        methods: [{ ...method("run", [call("choice.getTheCase")], [param("choice", "Choice")]),
          localTypes: [{ name: "choice", type: "", from: "this.fallback()" }] } as ReturnType<typeof method>],
      })], { language: "java" });
      const decoy = file("app/Other.java", [cls("Other", { methods: [returning("getTheCase", "Case", 3)] })], { language: "java" });
      expect(callsFrom(buildSymbolLinks([...domain(), decoy, svc]), "web/Action.java").map((l) => l.targetSymbol)).toEqual(["Choice.getTheCase"]);
    });

    it("refuses a hop it cannot type: no return type, a container, overloads that disagree, an index", () => {
      const overloaded = file("app/Repo.java", [cls("Repo", { methods: [returning("find", "Case", 3), returning("find", "Person", 7)] })], { language: "java" });
      const links = buildSymbolLinks([...domain(), overloaded, caller([
        call("choice.getOwner().getName"),
        call("repo.find(1).getId"),
        call("choice.getTheCase().getCaseState()[0].getId"),
        call("choice.unknown().getId"),
      ], { params: [param("choice", "Choice"), param("repo", "Repo")] })]);
      expect(callsFrom(links, "web/Action.java")).toEqual([]);
    });
  });

  it("sends a bare `super` to the base class's method of the same name, or its constructor", () => {
    const base = file("lib/base.rb", [cls("BaseCalc", { methods: [method("initialize", [], [], 2), method("run", [], [], 5)] })], { language: "ruby" });
    const child = file("lib/child.rb", [cls("Calc", {
      extends: "BaseCalc",
      methods: [method("initialize", [call("super")], [], 3), method("run", [call("super")], [], 8), method("other", [call("super")], [], 12)],
    })], { language: "ruby" });
    const out = callsFrom(buildSymbolLinks([base, child]), "lib/child.rb");
    expect(out.map((l) => [l.sourceSymbol, l.targetSymbol])).toEqual([["Calc.initialize", "BaseCalc.initialize"], ["Calc.run", "BaseCalc.run"]]);
  });

  it("leaves a `super()` that only receives a member call (Python) to that call", () => {
    const base = file("svc/base.py", [cls("Base", { methods: [method("save", [], [], 2), method("validate", [], [], 5)] })], { language: "python" });
    const child = file("svc/child.py", [cls("Child", { extends: "Base", methods: [method("save", [call("super", { line: 4 }), call("super().validate", { line: 4 })])] })], { language: "python" });
    const out = callsFrom(buildSymbolLinks([base, child]), "svc/child.py");
    expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([["super().validate", "Base.validate"]]);
  });

  it("reaches a method of the one mixed-in module that defines it — never a bare call where members need `this`", () => {
    const helper = file("app/helpers/std.rb", [cls("StdHelper", { methods: [method("_index", [], [], 3)] })], { language: "ruby" });
    const other = file("app/helpers/other.rb", [cls("OtherHelper", { methods: [method("_index", [], [], 3)] })], { language: "ruby" });
    const ctl = (impls: string[]) => file("app/controllers/x.rb", [cls("XController", { implements: impls, methods: [method("index", [call("_index")], [], 5)] })], { language: "ruby" });
    expect(callsFrom(buildSymbolLinks([helper, other, ctl(["StdHelper"])]), "app/controllers/x.rb").map((l) => l.targetSymbol)).toEqual(["StdHelper._index"]);
    expect(callsFrom(buildSymbolLinks([helper, other, ctl(["StdHelper", "OtherHelper"])]), "app/controllers/x.rb")).toEqual([]);
    const trait = file("app/HasRoles.php", [cls("HasRoles", { methods: [method("roles", [], [], 3)] })], { language: "php" });
    const decoy = file("app/Team.php", [cls("Team", { methods: [method("roles", [], [], 3)] })], { language: "php" });
    const user = file("app/User.php", [cls("User", { implements: ["HasRoles"], methods: [method("can", [call("this.roles"), call("roles")], [], 5)] })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([trait, decoy, user]), "app/User.php").map((l) => [l.callName, l.targetSymbol])).toEqual([["this.roles", "HasRoles.roles"]]);
  });

  it("finds `Outer::Inner.m` where Inner is declared nested inside Outer under its simple name", () => {
    const helper = file("app/helpers/p19_log_helper.rb", [
      { ...cls("P19LogHelper"), line: 1, endLine: 40 },
      { ...cls("P19Logger", { methods: [method("self.log", [], [], 12)] }), line: 10, endLine: 30 },
    ], { language: "ruby" });
    // The same simple name elsewhere, NOT nested in P19LogHelper.
    const other = file("lib/p19_logger.rb", [{ ...cls("P19Logger", { methods: [method("self.log", [], [], 3)] }), line: 1, endLine: 9 }], { language: "ruby" });
    const caller = file("app/models/absence.rb", [cls("Absence", { methods: [method("log", [call("P19LogHelper::P19Logger.log")])] })], { language: "ruby" });
    const out = callsFrom(buildSymbolLinks([helper, other, caller]), "app/models/absence.rb");
    expect(out.map((l) => [l.targetFile, l.targetSymbol])).toEqual([["app/helpers/p19_log_helper.rb", "P19Logger.self.log"]]);
  });

  it("reaches a function a sibling file of the same Go package declares — never a test file, never two", () => {
    const fn = (name: string, calls: CallInfo[] = [], line = 3) => method(name, calls, [], line);
    const embedding = file("internal/face/embedding.go", [], { language: "go", functions: [fn("normalizeEmbedding")] });
    const caller = file("internal/face/embeddings.go", [], { language: "go", functions: [fn("Load", [call("normalizeEmbedding"), call("testHelper"), call("detect"), call("elsewhere")], 9)] });
    const helper = file("internal/face/helper_test.go", [], { language: "go", functions: [fn("testHelper")] });
    const linux = file("internal/face/detect_linux.go", [], { language: "go", functions: [fn("detect")] });
    const windows = file("internal/face/detect_windows.go", [], { language: "go", functions: [fn("detect")] });
    const other = file("internal/other/x.go", [], { language: "go", functions: [fn("elsewhere")] });
    const out = callsFrom(buildSymbolLinks([embedding, caller, helper, linux, windows, other]), "internal/face/embeddings.go");
    expect(out.map((l) => [l.callName, l.targetFile, l.strategy])).toEqual([["normalizeEmbedding", "internal/face/embedding.go", "direct"]]);
  });

  it("joins an alias import, or a module written out, to the module declared by that name (Elixir)", () => {
    const sessions = file("lib/plausible/auth/user_sessions.ex", [cls("Plausible.Auth.UserSessions", { methods: [method("revoke_all", [], [], 4)] })], { language: "elixir" });
    const other = file("lib/other/user_sessions.ex", [cls("Other.UserSessions", { methods: [method("revoke_all", [], [], 4)] })], { language: "elixir" });
    const sso = { ...file("lib/plausible/auth/sso.ex", [cls("Plausible.Auth.SSO", { methods: [method("logout", [
      call("UserSessions.revoke_all", { kind: "cross-file", target: "Plausible.Auth.UserSessions" }),
      call("Plausible.Auth.UserSessions.revoke_all"),
    ])] })], { language: "elixir" }), imports: [{ source: "Plausible.Auth.UserSessions", specifiers: ["UserSessions"], line: 2 }] } as unknown as FileAnalysis;
    const out = callsFrom(buildSymbolLinks([sessions, other, sso]), "lib/plausible/auth/sso.ex");
    expect(out.map((l) => [l.callName, l.targetFile])).toEqual([
      ["UserSessions.revoke_all", "lib/plausible/auth/user_sessions.ex"],
      ["Plausible.Auth.UserSessions.revoke_all", "lib/plausible/auth/user_sessions.ex"],
    ]);
  });

  it("reaches a routine of a unit the caller `uses` (Pascal), case-insensitively", () => {
    const wait = file("WaitForm.pas", [], { language: "pascal", functions: [method("ShowWaitForm", [], [], 44)] });
    const unused = file("Other.pas", [], { language: "pascal", functions: [method("ShowWaitForm", [], [], 3)] });
    const form = { ...file("KarakterForm.pas", [cls("TfrmKarakter", { methods: [method("FormShow", [call("showWaitForm")], [], 90)] })], { language: "pascal" }),
      imports: [{ source: "WaitForm", specifiers: [], line: 8 }, { source: "SysUtils", specifiers: [], line: 8 }] } as unknown as FileAnalysis;
    const out = callsFrom(buildSymbolLinks([wait, unused, form]), "KarakterForm.pas");
    expect(out.map((l) => [l.targetFile, l.targetSymbol])).toEqual([["WaitForm.pas", "ShowWaitForm"]]);
  });

  it("follows a barrel's or a package __init__'s re-exports to the definition — unique or nothing", () => {
    const withIo = (a: FileAnalysis, extra: Record<string, unknown>) => ({ ...a, ...extra }) as unknown as FileAnalysis;
    const fn = (name: string, line = 3) => method(name, [], [], line);
    const format = file("src/utils/format.ts", [], { language: "typescript", functions: [fn("formatDate")] });
    const dup = file("src/utils/legacy.ts", [], { language: "typescript", functions: [fn("parse")] });
    const dup2 = file("src/utils/strict.ts", [], { language: "typescript", functions: [fn("parse")] });
    const barrel = withIo(file("src/utils/index.ts", [], { language: "typescript" }), { exports: [
      { name: "*", kind: "re-export", line: 1, source: "./format" },
      { name: "*", kind: "re-export", line: 2, source: "./legacy" },
      { name: "*", kind: "re-export", line: 3, source: "./strict" },
    ] });
    const caller = withIo(file("src/app.ts", [], { language: "typescript", functions: [method("run", [
      call("formatDate", { kind: "cross-file", target: "./utils" }),
      call("u.formatDate", { kind: "cross-file", target: "./utils" }),
      call("parse", { kind: "cross-file", target: "./utils" }),
    ])] }), { imports: [
      { source: "./utils", specifiers: ["formatDate", "parse"], isDefault: false, isNamespace: false, isType: false, line: 1 },
      { source: "./utils", specifiers: ["u"], isDefault: false, isNamespace: true, isType: false, line: 2 },
    ] });
    const ts = callsFrom(buildSymbolLinks([format, dup, dup2, barrel, caller]), "src/app.ts");
    expect(ts.map((l) => [l.callName, l.targetFile])).toEqual([["formatDate", "src/utils/format.ts"], ["u.formatDate", "src/utils/format.ts"]]);

    const deps = file("mealie/core/dependencies/dependencies.py", [], { language: "python", functions: [fn("get_admin_user")] });
    const init = withIo(file("mealie/core/dependencies/__init__.py", [], { language: "python" }), { exports: [{ name: "*", kind: "re-export", line: 1, source: ".dependencies" }] });
    const router = file("mealie/routes/routers.py", [], { language: "python", functions: [method("admin", [call("get_admin_user", { kind: "cross-file", target: "mealie.core.dependencies" })])] });
    const py = callsFrom(buildSymbolLinks([deps, init, router]), "mealie/routes/routers.py");
    expect(py.map((l) => [l.callName, l.targetFile])).toEqual([["get_admin_user", "mealie/core/dependencies/dependencies.py"]]);

    // A class forwarded by the barrel and called by name is constructed.
    const conv = file("pkg/units.py", [cls("UnitConverter", { methods: [method("__init__", [], [], 4)] })], { language: "python" });
    const pkg = withIo(file("pkg/__init__.py", [], { language: "python" }), { exports: [{ name: "*", kind: "re-export", line: 1, source: ".units" }] });
    const user = file("app/lists.py", [], { language: "python", functions: [method("make", [call("UnitConverter", { kind: "cross-file", target: "pkg" })])] });
    const made = callsFrom(buildSymbolLinks([conv, pkg, user]), "app/lists.py");
    expect(made.map((l) => [l.targetSymbol, l.strategy, l.relation])).toEqual([["UnitConverter.__init__", "constructor", "instantiates"]]);
  });

  it("matches a method name without regard to case where the language calls it so (PHP), never elsewhere", () => {
    const serializer = (path: string, language: string) => file(path, [cls("Serializer", {
      methods: [method("writeUtf", [], [], 3), method("serialize", [call("this.writeUTF"), call("writeUTF")], [], 8)],
    })], { language });
    const php = callsFrom(buildSymbolLinks([serializer("lib/Serializer.php", "php")]), "lib/Serializer.php");
    expect(php.map((l) => [l.callName, l.targetSymbol])).toEqual([["this.writeUTF", "Serializer.writeUtf"], ["writeUTF", "Serializer.writeUtf"]]);
    expect(callsFrom(buildSymbolLinks([serializer("lib/Serializer.java", "java")]), "lib/Serializer.java")).toEqual([]);
  });

  it("never folds case on a receiver: `handler.render` is not the class `Handler`'s own render", () => {
    const own = file("app/Handler.php", [cls("Handler", {
      methods: [method("render", [], [], 3), method("report", [call("handler.render")], [], 8)],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([own]), "app/Handler.php")).toEqual([]);
  });

  it("only binds the leaf on the receiver's own type, never an intermediate one", () => {
    // `this.repo.inner.find` — `inner` is untyped, so nothing may bind `find`
    // on UserRepository (the old leaf fallback did).
    const svc = file("Service/UserService.php", [cls("UserService", {
      properties: [prop("repo", "UserRepository")],
      methods: [method("a", [call("this.repo.inner.find")])],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), svc]), "Service/UserService.php")).toEqual([]);
  });

  it("still resolves `super().m()` / `super(Cls, self).m()` through the base class", () => {
    const base = file("svc/base.py", [cls("Base", { methods: [method("save", [], [], 2)] })], { language: "python" });
    const child = file("svc/child.py", [cls("Child", { extends: "Base", methods: [method("save", [call("super().save"), call("super(Child, self).save")])] })], { language: "python" });
    const out = callsFrom(buildSymbolLinks([base, child]), "svc/child.py");
    expect(out.map((l) => [l.callName, l.targetSymbol])).toEqual([["super().save", "Base.save"], ["super(Child, self).save", "Base.save"]]);
  });

  it("does not resolve `this.repo.find` to a base class's own `find`", () => {
    const base = file("Service/BaseService.php", [cls("BaseService", { methods: [method("find", [], [], 2)] })], { language: "php" });
    const svc = file("Service/UserService.php", [cls("UserService", {
      extends: "BaseService",
      properties: [prop("repo", "UserRepository")],
      methods: [method("a", [call("this.repo.find")])],
    })], { language: "php" });
    expect(callsFrom(buildSymbolLinks([repo(), base, svc]), "Service/UserService.php")[0]!.targetSymbol).toBe("UserRepository.find");
  });
});

describe("symbol-linker — interfaces keyed by definition", () => {
  it("does not pool implementations of two same-named interfaces", () => {
    const appIface = file("app/IAppService.cs", [cls("IAppService", { kind: "interface", methods: [method("Run")] })]);
    const appImpl = file("app/AppService.cs", [cls("AppService", { implements: ["IAppService"], methods: [method("Run", [], [], 4)] })]);
    const mobileIface = file("mobile/IAppService.cs", [cls("IAppService", { kind: "interface", methods: [method("Run")] })]);
    const mobileImpl = file("mobile/MobileAppService.cs", [cls("MobileAppService", { implements: ["IAppService"], methods: [method("Run", [], [], 4)] })]);
    const caller = consumer("app/Startup.cs", [call("_svc.Run")], [prop("_svc", "IAppService")]);
    const links = buildSymbolLinks([appIface, appImpl, mobileIface, mobileImpl, caller]);
    expect(callsFrom(links, "app/Startup.cs")[0]).toMatchObject({ targetSymbol: "AppService.Run", strategy: "interface-redirect" });
  });

  it("resolves a type split across files of one directory (class + extension)", () => {
    const decl = file("App/PgRepo.swift", [cls("PgRepo", { extends: "NSObject" })], { language: "swift" });
    const ext = file("App/PgRepo+UserRepo.swift", [cls("PgRepo", { implements: ["UserRepo"], methods: [method("load", [], [], 4)] })], { language: "swift" });
    const proto = file("App/UserRepo.swift", [cls("UserRepo", { kind: "interface", methods: [method("load")] })], { language: "swift" });
    const reg = file("App/DI.swift", [], { language: "swift", diBindings: [bind("UserRepo", "PgRepo")] });
    const svc = file("Feature/Reporter.swift", [cls("Reporter", {
      properties: [prop("repo", "UserRepo"), prop("pg", "PgRepo")],
      methods: [method("report", [call("repo.load"), call("pg.load")])],
    })], { language: "swift" });
    const out = callsFrom(buildSymbolLinks([decl, ext, proto, reg, svc]), "Feature/Reporter.swift");
    expect(out.map((l) => [l.callName, l.targetFile, l.targetSymbol])).toEqual([
      ["repo.load", "App/PgRepo+UserRepo.swift", "PgRepo.load"],
      ["pg.load", "App/PgRepo+UserRepo.swift", "PgRepo.load"],
    ]);
  });

  it("keeps same-named classes of one directory apart where types do not span files", () => {
    const repo = file("app/repo.py", [cls("SqlUserRepo", { methods: [method("load", [], [], 2)] })], { language: "python" });
    const a = file("app/cases/a.py", [cls("Svc", { properties: [prop("repo", "SqlUserRepo")] })], { language: "python" });
    const b = file("app/cases/b.py", [cls("Svc", { methods: [method("run", [call("self.repo.load")])] })], { language: "python" });
    expect(callsFrom(buildSymbolLinks([repo, a, b]), "app/cases/b.py")).toEqual([]);
  });

  it("finds a method defined beside its class in another file (partial class)", () => {
    const part1 = file("App/Report.cs", [cls("Report")]);
    const part2 = file("App/Report.Render.cs", [cls("Report", { methods: [method("Render", [], [], 8)] })]);
    // A decoy `Render` elsewhere: only the typed path can pick the right one.
    const decoy = file("Other/Other.cs", [cls("Other", { methods: [method("Render", [], [], 3)] })]);
    const caller = consumer("Web/ReportController.cs", [call("_report.Render")], [prop("_report", "Report")]);
    const links = buildSymbolLinks([part1, part2, decoy, caller]);
    expect(callsFrom(links, "Web/ReportController.cs")[0]).toMatchObject({ targetFile: "App/Report.Render.cs", targetSymbol: "Report.Render" });
  });
});

describe("symbol-linker — structural interfaces", () => {
  it("counts a type whose methods (across its package's files) cover a structural interface", () => {
    const iface = file("repo/repo.go", [{ ...cls("UserRepo", { kind: "interface", methods: [method("Find"), method("Save")] }), structural: true }], { language: "go" });
    // PgRepo's struct and its methods live in different files of the package.
    const struct = file("repo/pg.go", [cls("PgRepo", { properties: [prop("db", "DB")] })], { language: "go" });
    const methods = file("repo/pg_methods.go", [cls("PgRepo", { methods: [method("Find", [], [], 4), method("Save", [], [], 8)] })], { language: "go" });
    const partial = file("repo/mem.go", [cls("MemRepo", { methods: [method("Find", [], [], 3)] })], { language: "go" });
    const svc = file("svc/svc.go", [cls("Service", { properties: [prop("repo", "UserRepo")], methods: [method("Get", [call("repo.Find")])] })], { language: "go" });
    const links = buildSymbolLinks([iface, struct, methods, partial, svc]);
    // MemRepo lacks Save: not an implementation, so PgRepo is the only one.
    expect(callsFrom(links, "svc/svc.go")[0]).toMatchObject({ targetFile: "repo/pg_methods.go", targetSymbol: "PgRepo.Find", strategy: "interface-redirect" });
  });

  it("never matches a nominal interface structurally", () => {
    const iface = file("src/IRepo.ts", [cls("IRepo", { kind: "interface", methods: [method("find")] })], { language: "typescript" });
    const impl = file("src/Repo.ts", [cls("Repo", { methods: [method("find", [], [], 3)] })], { language: "typescript" });
    const svc = file("src/svc.ts", [cls("Svc", { properties: [prop("repo", "IRepo")], methods: [method("run", [call("this.repo.find")])] })], { language: "typescript" });
    expect(callsFrom(buildSymbolLinks([iface, impl, svc]), "src/svc.ts")[0]!.targetSymbol).toBe("IRepo.find");
  });
});
