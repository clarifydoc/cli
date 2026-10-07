import { describe, it, expect } from "vitest";
import { extractCallsFromBody, extractFunctionsWithSpec } from "../shared/regex-base.js";
import { swiftSpec } from "./index.js";
import { extractSwiftDiBindings, extractSwiftLocalTypes } from "./di.js";

const classes = (src: string) => swiftSpec.extractClasses!(src.split("\n"), []);
const bindings = (src: string) =>
  extractSwiftDiBindings(src.split("\n")).map((b) => {
    const { line: _line, ...rest } = b;
    return rest;
  });
const locals = (...body: string[]) => extractSwiftLocalTypes(body, { name: "f" });
const calls = (line: string) => extractCallsFromBody([line], 0, 1, ["//"], swiftSpec.callPatterns);

describe("swift protocols", () => {
  it("marks a protocol as an interface whose requirements end on their own line", () => {
    const [proto] = classes(
      [
        "protocol UserRepo: AnyObject {",
        "    func load(id: Int) -> User?",
        "    func find(id: Int) throws -> User?",
        "    func save(_ user: User) async throws",
        "    var count: Int { get }",
        "}",
      ].join("\n"),
    );
    expect(proto.kind).toBe("interface");
    expect(proto.methods.map((m) => [m.name, m.line, m.endLine, m.calls.length])).toEqual([
      ["load", 2, 2, 0],
      ["find", 3, 3, 0],
      ["save", 4, 4, 0],
    ]);
  });

  it("records a conformance declared by an extension", () => {
    const found = classes(["final class PgRepo: NSObject {", "}", "extension PgRepo: UserRepo, Cache {", "    func load(id: Int) -> User? { nil }", "}"].join("\n"));
    expect(found.map((c) => [c.name, c.extends, c.implements, c.kind])).toEqual([
      ["PgRepo", "NSObject", [], undefined],
      ["PgRepo", null, ["UserRepo", "Cache"], undefined],
    ]);
  });
});

describe("swift injected members", () => {
  const props = (...body: string[]) => classes(["final class S {", ...body, "}"].join("\n"))[0]!.properties;

  it("reads the key an injecting wrapper names", () => {
    expect(
      props(
        "    @Injected(\\.userRepo) private var repo: UserRepo",
        "    @Injected(Container.legacyRepo) var legacy: UserRepo",
        "    @Injected(name: \"mem\") var mem: UserRepo",
        "    @Injected(name: .fast) var fast: UserRepo",
        "    @Injected var plain: UserRepo",
        "    @LazyInjected(\\Container.cache)",
        "    var cache: Cache",
      ).map((p) => [p.name, p.type, p.qualifier]),
    ).toEqual([
      ["repo", "UserRepo", "userRepo"],
      ["legacy", "UserRepo", "legacyRepo"],
      ["mem", "UserRepo", "mem"],
      ["fast", "UserRepo", "fast"],
      ["plain", "UserRepo", undefined],
      ["cache", "Cache", "cache"],
    ]);
  });

  it("keeps an untyped wrapper member only when its wrapper names a key", () => {
    expect(props("    @Injected(\\.memRepo) var mem", "    @Injected var anon").map((p) => [p.name, p.type, p.qualifier])).toEqual([
      ["mem", null, "memRepo"],
    ]);
  });

  it("types an unannotated member from its construction or container lookup", () => {
    expect(
      props(
        "    private let repo = PgRepo()",
        "    private lazy var audit = container.resolve(Auditing.self)!",
        "    let named: UserRepo = container.resolve(UserRepo.self, name: \"mem\")!",
        "    weak var delegate: Delegate?",
        "    let id = UUID()",
        "    let client = HTTPClient()",
        "        .configured(timeout: 3)",
        "    var count = 0",
        "    func f() {",
        "        let local = PgRepo()",
        "    }",
      ).map((p) => [p.name, p.type, p.qualifier]),
    ).toEqual([
      ["repo", "PgRepo", undefined],
      ["audit", "Auditing", undefined],
      ["named", "UserRepo", "mem"],
      ["delegate", "Delegate?", undefined],
    ]);
  });
});

describe("swift locals", () => {
  it("types locals from annotations, constructions, lookups and casts", () => {
    expect(
      locals(
        "let a = ConcRepo()",
        "let b: UserRepo = PgRepo()",
        "var d = Repo<User>(db: db)",
        "let r = container.resolve(UserRepo.self)!",
        "let m = container.resolve(UserRepo.self, name: \"mem\")",
        "let r2: UserRepo = Resolver.resolve()",
        "let r3 = Resolver.resolve(Cache.self, name: .fast)",
        "if let r4 = container.resolve(Auditing.self) {",
        "guard let r5 = container.resolve(Mailer.self) else { return }",
        "let f = Container.shared.userRepo()",
        "let c = thing as! Cache",
        "let x = makeRepo()",
        "let y = PgRepo().configured()",
      ),
    ).toEqual([
      { name: "a", type: "ConcRepo" },
      { name: "b", type: "UserRepo" },
      { name: "d", type: "Repo<User>" },
      { name: "r", type: "UserRepo" },
      { name: "m", type: "UserRepo", qualifier: "mem" },
      { name: "r2", type: "UserRepo" },
      { name: "r3", type: "Cache", qualifier: "fast" },
      { name: "r4", type: "Auditing" },
      { name: "r5", type: "Mailer" },
      { name: "f", type: "", qualifier: "userRepo" },
      { name: "c", type: "Cache" },
    ]);
  });

  it("drops a name declared with two different types", () => {
    expect(locals("if a {", "    let r = PgRepo()", "} else {", "    let r = MemRepo()", "}", "let s = PgRepo()")).toEqual([
      { name: "s", type: "PgRepo" },
    ]);
  });

  it("keeps a name expression it cannot read as the key, so the unnamed registration never answers", () => {
    expect(locals("let k = container.resolve(UserRepo.self, name: key)!")).toEqual([{ name: "k", type: "UserRepo", qualifier: "key" }]);
  });

  it("does not type a local whose initializer wraps onto a chain below", () => {
    expect(locals("let client = HTTPClient()", "    .configured(timeout: 3)", "let other = PgRepo()", "")).toEqual([{ name: "other", type: "PgRepo" }]);
  });

  it("reads each statement of a one-line body", () => {
    const [fn] = extractFunctionsWithSpec(["func go() { let r = PgRepo(); let c = container.resolve(Cache.self)!; r.load(id: 1) }"], swiftSpec);
    expect(fn!.localTypes).toEqual([
      { name: "r", type: "PgRepo" },
      { name: "c", type: "Cache" },
    ]);
  });

  it("attaches locals to an extracted method", () => {
    const [fn] = extractFunctionsWithSpec(["func go() {", "    let r = container.resolve(UserRepo.self)!", "    r.load(id: 1)", "}"], swiftSpec);
    expect(fn!.localTypes).toEqual([{ name: "r", type: "UserRepo" }]);
  });
});

describe("swift lookups chained into a call", () => {
  it("types the receiver of an inline container lookup", () => {
    expect(calls("_ = container.resolve(UserRepo.self)!.load(id: 1)")[0]).toMatchObject({
      name: "container.resolve(UserRepo.self).load",
      receiverType: "UserRepo",
    });
    expect(calls("_ = try Resolver.resolve(UserRepo.self, name: \"mem\")?.find(id: 1)")[0]).toMatchObject({
      receiverType: "UserRepo",
      receiverQualifier: "mem",
    });
  });

  it("keys a Factory lookup by its key path", () => {
    const [call] = calls("_ = Container.shared.userRepo().find(id: 1)");
    expect(call).toMatchObject({ name: "Container.userRepo().find", receiverQualifier: "userRepo" });
    expect(call!.receiverType).toBeUndefined();
  });

  it("gives an untyped receiver no type", () => {
    expect(calls("_ = repo.find(id: 1)").every((c) => !c.receiverType && !c.receiverQualifier)).toBe(true);
  });
});

describe("swift container registrations", () => {
  it("reads Swinject registrations, named ones keyed only", () => {
    expect(
      bindings(
        [
          "container.register(UserRepo.self) { _ in",
          "    PgRepo()",
          "}.inObjectScope(.container)",
          "container.register(UserRepo.self, name: \"mem\", factory: { _ in MemRepo() })",
          "container.register(Mailer.self) { r in SmtpMailer(repo: r.resolve(UserRepo.self)!) }",
          "c.autoregister(Auditing.self, initializer: SqlAudit.init)",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "register" },
      { service: "UserRepo", implementation: "MemRepo", via: "register", qualifier: "mem", keyedOnly: true },
      { service: "Mailer", implementation: "SmtpMailer", via: "register" },
      { service: "Auditing", implementation: "SqlAudit", via: "autoregister" },
    ]);
  });

  it("emits nothing for a self registration, a statement-list factory, UIKit or a declaration", () => {
    expect(
      bindings(
        [
          "container.register(UserService.self) { r in UserService(repo: r.resolve(UserRepo.self)!) }",
          "container.register(Reporter.self) { r in",
          "    let x = Reporter()",
          "    return x",
          "}",
          "container.register(UserRepo.self) { _ in PgRepo.shared }",
          "tableView.register(UserCell.self, forCellReuseIdentifier: \"cell\")",
          "func register(_ type: Any.Type) {",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("emits both of two unconditional registrations", () => {
    expect(
      bindings(["container.register(UserRepo.self) { _ in PgRepo() }", "container.register(UserRepo.self) { _ in MemRepo() }"].join("\n")).map(
        (b) => b.implementation,
      ),
    ).toEqual(["PgRepo", "MemRepo"]);
  });

  it("reads Resolver's cast, explicit and `.implements` forms", () => {
    expect(
      bindings(
        [
          "register { PgRepo() as UserRepo }",
          "register(Cache.self) { MemCache() }",
          "register { SqlAudit() }",
          "    .implements(Auditing.self)",
          "    .implements(Logging.self, name: \"audit\")",
          "register(name: .mem) { MemRepo() as UserRepo }",
          "register { Plain() }",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "UserRepo", implementation: "PgRepo", via: "register" },
      { service: "Cache", implementation: "MemCache", via: "register" },
      { service: "Auditing", implementation: "SqlAudit", via: "implements" },
      { service: "Logging", implementation: "SqlAudit", via: "implements", qualifier: "audit", keyedOnly: true },
      { service: "UserRepo", implementation: "MemRepo", via: "register", qualifier: "mem", keyedOnly: true },
    ]);
  });

  it("reads Factory keys, each context override as another implementation", () => {
    expect(
      bindings(
        [
          "extension Container {",
          "    var userRepo: Factory<UserRepo> {",
          "        self { PgRepo() }",
          "            .onTest { MockRepo() }",
          "            .singleton",
          "    }",
          "    var memRepo: Factory<UserRepo> { Factory(self) { MemRepo() } }",
          "    var byId: ParameterFactory<Int, UserRepo> { self { id in PgRepo(id: id) } }",
          "    static let legacy = Factory<UserRepo>(scope: .singleton) { PgRepo() }",
          "}",
          "let _ = Container.shared.userRepo.register { PreviewRepo() }",
        ].join("\n"),
      ),
    ).toEqual([
      { service: "userRepo", implementation: "PgRepo", via: "Factory", keyedOnly: true },
      { service: "userRepo", implementation: "MockRepo", via: "Factory", keyedOnly: true },
      { service: "memRepo", implementation: "MemRepo", via: "Factory", keyedOnly: true },
      { service: "byId", implementation: "PgRepo", via: "Factory", keyedOnly: true },
      { service: "legacy", implementation: "PgRepo", via: "Factory", keyedOnly: true },
      { service: "userRepo", implementation: "PreviewRepo", via: "Factory", keyedOnly: true },
    ]);
  });
});
