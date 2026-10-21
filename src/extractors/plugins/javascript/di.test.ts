import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { restoreHeldCalls } from "../../shared/call-graph.js";
import type { ClassInfo, FunctionInfo, ImportInfo } from "../../../types/analysis.js";

/**
 * Dependency-injection facts the TS/JS extractor reports for the linker:
 * injection-point types and tokens (constructor parameters, parameter
 * properties, decorated and initialized fields, constructor assignments),
 * typed locals and container lookups, receiver types of a lookup or cast
 * chained into a call, abstract members, and the JSDoc that types plain JS.
 */
async function extract(src: string, file = "x.ts"): Promise<{ classes: ClassInfo[]; functions: FunctionInfo[] }> {
  const lang = file.endsWith(".js") ? "javascript" : "typescript";
  const tree = await parseSource(src, lang as any, file);
  const x = new JavaScriptExtractor();
  return { functions: x.extractFunctions(tree, src), classes: x.extractClasses(tree, src) };
}

const cls = (r: { classes: ClassInfo[] }, name: string) => r.classes.find((c) => c.name === name)!;
const method = (c: ClassInfo, name: string) => c.methods.find((m) => m.name === name)!;
const prop = (c: ClassInfo, name: string) => c.properties.find((p) => p.name === name);
const param = (fn: FunctionInfo, name: string) => fn.params.find((p) => p.name === name)!;

describe("injection points — constructor parameters and parameter properties", () => {
  it("reads the token of @Inject/@inject onto the parameter AND the property it declares", async () => {
    const r = await extract(`
      export class CarsService {
        constructor(
          @Inject(PLAYER_REPO) private readonly players: IPlayerRepository,
          @Inject('PAYMENT') private readonly payments: IPaymentGateway,
          @Inject(forwardRef(() => LateService)) private late: ILate,
          @inject(TYPES.PlayerRepo) private readonly repo: IPlayerRepo,
          @Inject(AUDIT_LOG) auditParam: IAuditLog,
          private readonly mailer: MailerService,
        ) {}
      }`);
    const c = cls(r, "CarsService");
    const ctor = method(c, "constructor");
    expect(param(ctor, "players")).toMatchObject({ type: "IPlayerRepository", qualifier: "PLAYER_REPO" });
    expect(param(ctor, "payments").qualifier).toBe("PAYMENT");
    expect(param(ctor, "late").qualifier).toBe("LateService");
    expect(param(ctor, "repo").qualifier).toBe("TYPES.PlayerRepo");
    expect(param(ctor, "auditParam")).toMatchObject({ type: "IAuditLog", qualifier: "AUDIT_LOG" });
    expect(param(ctor, "mailer").qualifier).toBeUndefined();
    expect(prop(c, "players")).toMatchObject({ type: "IPlayerRepository", qualifier: "PLAYER_REPO" });
    expect(prop(c, "repo")?.qualifier).toBe("TYPES.PlayerRepo");
    expect(prop(c, "mailer")?.qualifier).toBeUndefined();
    // A plain parameter (no modifier) declares no property.
    expect(prop(c, "auditParam")).toBeUndefined();
  });

  it("drops a token that only restates the declared type, and types an untyped class token", async () => {
    const r = await extract(`
      class A {
        constructor(
          @Inject(ClockService) private readonly clock: ClockService,
          @inject('IClubRepo') private repo: IClubRepo,
          @Inject(ClockService) private untyped,
        ) {}
      }`);
    const ctor = method(cls(r, "A"), "constructor");
    expect(param(ctor, "clock").qualifier).toBeUndefined();
    expect(param(ctor, "repo").qualifier).toBeUndefined();
    expect(param(ctor, "untyped")).toMatchObject({ type: "ClockService" });
    expect(param(ctor, "untyped").qualifier).toBeUndefined();
  });

  it("an InversifyJS name/tag is the qualifier (it is what selects among a token's registrations)", async () => {
    const r = await extract(`
      class A {
        constructor(
          @inject(TYPES.Logger) @named('file') private logger: ILogger,
          @inject(TYPES.Weapon) @tagged('canThrow', true) private weapon: IWeapon,
        ) {}
      }`);
    const ctor = method(cls(r, "A"), "constructor");
    expect(param(ctor, "logger").qualifier).toBe("file");
    expect(param(ctor, "weapon").qualifier).toBe("canThrow=true");
  });
});

describe("injection points — fields", () => {
  it("decorated fields carry their token", async () => {
    const r = await extract(`
      class S {
        @Inject(AUDIT_LOG) private auditProp!: IAuditLog;
        @inject(TYPES.Parser) @optional() private parser?: IParser;
        @Inject(ClockService) private readonly clock: ClockService;
      }`);
    const c = cls(r, "S");
    expect(prop(c, "auditProp")).toMatchObject({ type: "IAuditLog", qualifier: "AUDIT_LOG" });
    expect(prop(c, "parser")).toMatchObject({ type: "IParser", qualifier: "TYPES.Parser" });
    expect(prop(c, "clock")?.qualifier).toBeUndefined();
  });

  it("initializers type untyped fields: inject(), inject<T>(TOKEN), a same-file InjectionToken<T>, new", async () => {
    const r = await extract(`
      export const ANALYTICS = new InjectionToken<IAnalytics>('analytics');
      export class C {
        private svc = inject(PlayerService);
        private notifier = inject<Notifier>(NOTIFIER);
        private analytics = inject(ANALYTICS);
        private formatter = inject(FORMATTER);
        private typed: PlayerService = inject(PlayerService);
        private gadget = new GadgetService();
        private wrapped = new ns.Repo<Player>();
        @Output() select = new EventEmitter<Player>();
        private plain = makeThing();
        count = 0;
      }`);
    const c = cls(r, "C");
    expect(prop(c, "svc")).toMatchObject({ type: "PlayerService" });
    expect(prop(c, "svc")?.qualifier).toBeUndefined();
    expect(prop(c, "notifier")).toMatchObject({ type: "Notifier", qualifier: "NOTIFIER" });
    expect(prop(c, "analytics")).toMatchObject({ type: "IAnalytics", qualifier: "ANALYTICS" });
    // Token declared elsewhere: the qualifier alone (the registration decides).
    expect(prop(c, "formatter")).toMatchObject({ type: null, qualifier: "FORMATTER" });
    expect(prop(c, "typed")?.type).toBe("PlayerService");
    expect(prop(c, "gadget")?.type).toBe("GadgetService");
    expect(prop(c, "wrapped")?.type).toBe("Repo");
    expect(prop(c, "select")?.type).toBe("EventEmitter");
    expect(prop(c, "plain")?.type).toBeNull();
    expect(prop(c, "count")?.type).toBeNull();
  });

  it("a constructor assignment carries the parameter's type and token onto the field", async () => {
    const r = await extract(`
      class F {
        private auditField: IAuditLog;
        private later;
        constructor(@Inject(AUDIT_LOG) auditParam: IAuditLog, other: Other) {
          this.auditField = auditParam;
          this.later = new LateBound();
          this.twice = other;
          this.twice = new Different();
        }
      }`);
    const c = cls(r, "F");
    expect(prop(c, "auditField")).toMatchObject({ type: "IAuditLog", qualifier: "AUDIT_LOG" });
    expect(prop(c, "later")?.type).toBe("LateBound");
    // Two top-level assignments that disagree state nothing.
    expect(prop(c, "twice")).toBeUndefined();
  });

  it("types a field another method constructs, unless the constructions disagree or the constructor sets it otherwise", async () => {
    const r = await extract(`
      class Svc {
        private repo;
        private audit: AuditRepo | undefined;
        static shared;
        constructor(dep) { this.injected = dep; this.cache = null; }
        init() {
          this.repo = new PlayerRepo();
          if (!this.cache) this.cache = new Cache();
          this.mixed = new A();
          this.injected = new Replacement();
          const later = function () { this.notMine = new Other(); };
        }
        reset() { this.repo = null; this.mixed = new B(); }
        static boot() { this.shared = new Shared(); }
      }`);
    const c = cls(r, "Svc");
    expect(prop(c, "repo")?.type).toBe("PlayerRepo");
    expect(prop(c, "cache")?.type).toBe("Cache");
    // Its own declaration wins.
    expect(prop(c, "audit")?.type).toBe("AuditRepo | undefined");
    expect(prop(c, "mixed")).toBeUndefined();
    expect(prop(c, "injected")).toBeUndefined();
    expect(prop(c, "notMine")).toBeUndefined();
    expect(prop(c, "shared")?.type ?? null).toBeNull();
  });
});

describe("abstract classes", () => {
  it("keeps abstract method signatures as methods and marks an all-abstract class an interface", async () => {
    const r = await extract(`
      export abstract class AuditTrail { abstract appendEntry(e: string): void; }
      export abstract class CacheStore {
        abstract fetchValue(key: string): string;
        describe(): string { return 'cache'; }
      }
      export abstract class WithField { abstract run(): void; protected name = 'x'; }
      export abstract class AbstractField { abstract readonly id: string; abstract run(): void; }`);
    const trail = cls(r, "AuditTrail");
    expect(trail.kind).toBe("interface");
    expect(method(trail, "appendEntry")).toMatchObject({ calls: [], line: 2 });
    expect(method(trail, "appendEntry").params[0]).toMatchObject({ name: "e", type: "string" });

    const cache = cls(r, "CacheStore");
    expect(cache.kind).toBeUndefined();
    expect(cache.methods.map((m) => m.name)).toEqual(["fetchValue", "describe"]);
    expect(cls(r, "WithField").kind).toBeUndefined();
    expect(cls(r, "AbstractField").kind).toBe("interface");
  });
});

describe("typed locals (FunctionInfo.localTypes)", () => {
  it("reads annotations, constructions, container lookups and casts", async () => {
    const r = await extract(`
      class S {
        locators() {
          const viaLocator = this.moduleRef.get(ReportService);
          const typedLocal: ReportService = this.moduleRef.get(ReportService);
          const newed = new ReportService();
          const notif = this.moduleRef.get<INotifier>(NOTIFIER);
          const repo = container.get<IPlayerRepo>(TYPES.PlayerRepo);
          const mailer: IMailer = container.get(TYPES.Mailer);
          const bare = container.get(TYPES.Bare);
          const resolved = container.resolve<IClubRepo>('IClubRepo');
          const named = container.getNamed<ILogger>(TYPES.Logger, 'file');
          const located = this.injector.get(PlayerService);
          const tb = TestBed.inject(PlayerService);
          const local = inject(PlayerService);
          const cast = something() as GadgetService;
        }
        async boot() { const app = await NestFactory.create(AppModule); const typed = await app.resolve(ReportService); }
      }`);
    const locals = method(cls(r, "S"), "locators").localTypes;
    expect(locals).toEqual([
      { name: "viaLocator", type: "ReportService" },
      { name: "typedLocal", type: "ReportService" },
      { name: "newed", type: "ReportService" },
      { name: "notif", type: "INotifier", qualifier: "NOTIFIER" },
      { name: "repo", type: "IPlayerRepo", qualifier: "TYPES.PlayerRepo" },
      { name: "mailer", type: "IMailer", qualifier: "TYPES.Mailer" },
      { name: "bare", type: "", qualifier: "TYPES.Bare" },
      { name: "resolved", type: "IClubRepo" },
      { name: "named", type: "ILogger", qualifier: "file" },
      { name: "located", type: "PlayerService" },
      { name: "tb", type: "PlayerService" },
      { name: "local", type: "PlayerService" },
      { name: "cast", type: "GadgetService" },
    ]);
    expect(method(cls(r, "S"), "boot").localTypes).toEqual([
      { name: "app", type: "", from: "NestFactory.create()", awaited: true },
      { name: "typed", type: "ReportService" },
    ]);
  });

  it("states no type for what is not a container lookup or a receiver type — a call initializer is kept for the linker", async () => {
    const r = await extract(`
      function f(handlers: Map<Function, Handler>) {
        const h = handlers.get(CreatePlayer);
        const port = app.get('port');
        const route = app.get('/x', handler);
        const seen = new Set<string>();
        const out: Car[] = [];
        const value = compute();
        const res = await this.http.get<Player>('/api/player');
      }`);
    // The linker types `h`/`value` only through what the called function is declared to return.
    expect(r.functions.find((fn) => fn.name === "f")!.localTypes).toEqual([
      { name: "h", type: "", from: "handlers.get()" },
      { name: "port", type: "", from: "app.get()" },
      { name: "route", type: "", from: "app.get()" },
      { name: "value", type: "", from: "compute()" },
    ]);
  });

  it("keeps every call a local is initialized from, and none when another binding states a type", async () => {
    const r = await extract(`
      function h(flag: boolean) {
        let api;
        if (flag) { const client = makeA(); } else { const client = makeB(); }
        const mixed = makeC();
        if (flag) { const mixed = new Other(); }
      }`);
    expect(r.functions.find((fn) => fn.name === "h")!.localTypes).toEqual([
      { name: "client", type: "", from: "makeA()" },
      { name: "client", type: "", from: "makeB()" },
    ]);
  });

  it("reads module-scope locals for the file's <setup> (a Vue <script setup>, a module's top level)", async () => {
    const { topLevelLocalTypes } = await import("./functions-classes.js");
    const src = `
      import { usePlayerApi } from "~/composables/api";
      const api = usePlayerApi();
      const repo = new CarRepo();
      async function save() { const local = makeLocal(); await api.mealplans.createOne({}); }
    `;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    expect(topLevelLocalTypes(tree, src)).toEqual([
      { name: "api", type: "", from: "usePlayerApi()" },
      { name: "repo", type: "CarRepo" },
    ]);
  });

  it("reports a name only when every binding of it agrees (unique-or-nothing)", async () => {
    const r = await extract(`
      function g(repo: IRepo) {
        const repo2 = new SqlRepo();
        if (a) { const twice = new A(); } else { const twice = new B(); }
        let reassigned = new A();
        reassigned = other();
        let annotated: Repo = new Repo();
        annotated = other();
        const shadowed = new A();
        items.forEach((shadowed) => shadowed.run());
        try { } catch (caught) { }
        const caught = new A();
        const repo = new Other();
        const inner = () => { const nestedOnly = new Hidden(); };
      }`);
    const fn = r.functions.find((x) => x.name === "g")!;
    expect(fn.localTypes).toEqual([
      { name: "repo2", type: "SqlRepo" },
      { name: "annotated", type: "Repo" },
    ]);
    // A named nested arrow is its own function with its own locals.
    expect(r.functions.find((x) => x.name === "inner")!.localTypes).toEqual([{ name: "nestedOnly", type: "Hidden" }]);
  });
});

describe("receiver types of a lookup or cast chained into a call (CallInfo.receiverType)", () => {
  it("types the receiver and keeps noise-named leaves on a typed receiver", async () => {
    const r = await extract(`
      function main(map: Map<string, X>) {
        this.injector.get(PlayerService).countPlayers();
        container.get<IPlayerRepo>(TYPES.PlayerRepo).fetchPlayerById(9);
        container.get(TYPES.Repo).find(1);
        (await app.resolve(ReportService)).buildReport();
        (this.gadget as GadgetService).buffGadget();
        (<GadgetService>other).waxGadget();
        (x as any).map(f);
        cache.get(PlayerService).thing();
        this.service.doWork();
      }`);
    const calls = r.functions.find((fn) => fn.name === "main")!.calls;
    const byName = (n: string) => calls.find((c) => c.name.replace(/\s+/g, "") === n);
    expect(byName("this.injector.get(PlayerService).countPlayers")).toMatchObject({ receiverType: "PlayerService" });
    expect(byName("container.get<IPlayerRepo>(TYPES.PlayerRepo).fetchPlayerById")).toMatchObject({
      receiverType: "IPlayerRepo",
      receiverQualifier: "TYPES.PlayerRepo",
    });
    // A lookup by token alone carries the token and no type.
    expect(byName("container.get(TYPES.Repo).find")).toMatchObject({ receiverQualifier: "TYPES.Repo" });
    expect(byName("container.get(TYPES.Repo).find")?.receiverType).toBeUndefined();
    expect(byName("(awaitapp.resolve(ReportService)).buildReport")).toMatchObject({ receiverType: "ReportService" });
    expect(byName("(this.gadgetasGadgetService).buffGadget")).toMatchObject({ receiverType: "GadgetService" });
    expect(byName("(<GadgetService>other).waxGadget")).toMatchObject({ receiverType: "GadgetService" });
    // `as any` names no receiver type: `.map` stays noise.
    expect(byName("(xasany).map")).toBeUndefined();
    expect(byName("cache.get(PlayerService).thing")?.receiverType).toBeUndefined();
    expect(byName("this.service.doWork")?.receiverType).toBeUndefined();
  });
});

describe("held noise calls survive the body scan (calls array identity)", () => {
  it("restoreHeldCalls finds the held `repo.find` on the stored array", async () => {
    const r = await extract(`
      class S {
        run(repo: IRepo) { const x = import('./lazy.vue'); repo.find(1); repo.load(); }
      }`);
    const m = method(cls(r, "S"), "run");
    expect(m.calls.map((c) => c.name)).toEqual(["repo.load", "default"]);
    expect(restoreHeldCalls(m.calls, () => true)).toBe(1);
    expect(m.calls.map((c) => c.name)).toEqual(["repo.find", "repo.load", "default"]);
  });
});

describe("plain JavaScript: JSDoc types, fields, constructor assignments", () => {
  const SRC = `
import { Mailer } from '../mail/mailer.js';

/** @implements {IAudit} */
export class SignupService {
  /** @type {import('../repos/player-repo.js').PlayerRepo} */
  repoField;
  other = new Mailer();
  #secret = 1;
  static shared;

  /**
   * @param {PlayerRepo} repo
   * @param {?Mailer} mailer
   * @param {AuditLog=} [audit]
   */
  constructor(repo, mailer, audit = defaultAudit) {
    this.repo = repo;
    this.mailer = mailer;
    this.audit = audit;
    /** @type {Clock} */
    this.clock = makeClock();
    this.untyped = compute();
  }

  /** @param {PlayerRepo} extraRepo */
  run(extraRepo) {
    /** @type {PlayerRepo} */
    const r = locate('repo');
    const m = new Mailer();
  }
}

/** @interface */
export class AuditLog {
  /** @param {string} e */
  writeAudit(e) { throw new Error('abstract'); }
}

/** @param {PlayerRepo} repo */
export function standalone(repo) {}

/** @param {PlayerRepo} repo */
export const arrow = (repo) => repo;
`;

  it("types parameters, fields and locals from JSDoc and initializers", async () => {
    const r = await extract(SRC, "signup.js");
    const c = cls(r, "SignupService");
    expect(c.implements).toEqual(["IAudit"]);
    const ctor = method(c, "constructor");
    expect(ctor.params.map((p) => [p.name, p.type, p.defaultValue])).toEqual([
      ["repo", "PlayerRepo", null],
      ["mailer", "Mailer", null],
      ["audit", "AuditLog", "defaultAudit"],
    ]);
    expect(prop(c, "repoField")?.type).toBe("PlayerRepo");
    expect(prop(c, "other")?.type).toBe("Mailer");
    expect(prop(c, "#secret")).toMatchObject({ visibility: "private", type: null });
    expect(prop(c, "shared")).toMatchObject({ isStatic: true });
    expect(prop(c, "repo")?.type).toBe("PlayerRepo");
    expect(prop(c, "mailer")?.type).toBe("Mailer");
    expect(prop(c, "audit")?.type).toBe("AuditLog");
    expect(prop(c, "clock")?.type).toBe("Clock");
    // Nothing states the type: not invented.
    expect(prop(c, "untyped")).toBeUndefined();
    const run = method(c, "run");
    expect(param(run, "extraRepo").type).toBe("PlayerRepo");
    expect(run.localTypes).toEqual([
      { name: "r", type: "PlayerRepo" },
      { name: "m", type: "Mailer" },
    ]);
    expect(cls(r, "AuditLog").kind).toBe("interface");
    expect(param(r.functions.find((f) => f.name === "standalone")!, "repo").type).toBe("PlayerRepo");
    expect(param(r.functions.find((f) => f.name === "arrow")!, "repo").type).toBe("PlayerRepo");
  });

  it("a TypeScript annotation wins over JSDoc", async () => {
    const r = await extract(`
      /** @param {Wrong} repo */
      export function f(repo: Right) {}`);
    expect(param(r.functions[0]!, "repo").type).toBe("Right");
  });
});

describe("variable aliases skip container lookups", () => {
  it("does not bind `const x = inject(PlayerService)` to @angular/core", async () => {
    const src = `
      import { inject } from '@angular/core';
      import { usePlayerStore } from './stores/players';
      function f() {
        const local = inject(PlayerService);
        const store = usePlayerStore();
      }`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const imports: ImportInfo[] = [
      { source: "@angular/core", specifiers: ["inject"], isDefault: false, isNamespace: false, isType: false, line: 2 },
      { source: "./stores/players", specifiers: ["usePlayerStore"], isDefault: false, isNamespace: false, isType: false, line: 3 },
    ];
    const aliases = extractJsVariableAliases(tree, imports);
    expect(aliases.has("local")).toBe(false);
    expect(aliases.get("store")).toMatchObject({ source: "./stores/players", factory: "usePlayerStore" });
  });
});
