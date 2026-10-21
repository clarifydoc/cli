import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonExtractor } from "./functions-classes.js";
import { docstringParamTypes, extractPythonDiBindings, injectionToken } from "./di.js";

async function extract(src: string) {
  const tree = await parseSource(src, "python" as never, "a.py");
  const ex = new PythonExtractor();
  return { functions: ex.extractFunctions(tree, src), classes: ex.extractClasses(tree, src) };
}

async function bindings(src: string) {
  const tree = await parseSource(src, "python" as never, "a.py");
  return extractPythonDiBindings(tree, src).map((b) => {
    const { line: _line, ...rest } = b;
    return rest;
  });
}

const props = (cls: { properties: Array<{ name: string; type: string | null; qualifier?: string }> }) =>
  cls.properties.map((p) => (p.qualifier ? { name: p.name, type: p.type, qualifier: p.qualifier } : { name: p.name, type: p.type }));

describe("Python instance attributes", () => {
  it("types self attributes from the parameter, a construction, an annotation or a type comment", async () => {
    const { classes } = await extract(`
class Svc:
    def __init__(self, store: ClubStore, repo: Optional[PlayerRepo] = None, other=Provide[Container.repo], legacy=None):
        self._clubs = store
        self.repo = repo
        self.made = SqlPlayerRepo(db)
        self.typed: ClubStore = make()
        self.legacy = legacy  # type: LegacyStore
        self.injected = other
        self.none = None
        self.count = 0
`);
    expect(props(classes[0]!)).toEqual([
      { name: "_clubs", type: "ClubStore" },
      { name: "repo", type: "Optional[PlayerRepo]" },
      { name: "made", type: "SqlPlayerRepo" },
      { name: "typed", type: "ClubStore" },
      { name: "legacy", type: "LegacyStore" },
      { name: "injected", type: null, qualifier: "Container.repo" },
    ]);
    expect(classes[0]!.properties[0]!.visibility).toBe("private");
  });

  it("leaves an attribute untyped when any method assigns it something the source does not type", async () => {
    const { classes } = await extract(`
class Svc:
    def __init__(self, fast):
        self.repo = SqlPlayerRepo()
        if fast:
            self.same = SqlPlayerRepo()
        else:
            self.same = SqlPlayerRepo(1)
        if fast:
            self.differ = SqlPlayerRepo()
        else:
            self.differ = TwinRepo()

    def reset(self, other):
        self.repo = other
`);
    expect(props(classes[0]!)).toEqual([{ name: "same", type: "SqlPlayerRepo" }]);
  });

  it("keeps a class-level annotation over what __init__ assigns, and ignores static/class methods", async () => {
    const { classes } = await extract(`
class Svc:
    repo: PlayerRepo

    def __init__(self, repo: SqlPlayerRepo):
        self.repo = repo

    @classmethod
    def build(cls):
        cls.cache = Cache()
`);
    expect(props(classes[0]!)).toEqual([{ name: "repo", type: "PlayerRepo" }]);
  });
});

describe("Python locals", () => {
  it("types constructed, annotated, commented, cast and container-fetched locals", async () => {
    const { functions } = await extract(`
def run(container: Container, x):
    a = SqlPlayerRepo()
    b: PlayerRepo = make()
    c = x  # type: Store
    d = cast(PlayerRepo, x)
    e = injector.get(PlayerRepo)
    f = ServiceLocator.resolve(PlayerRepo)
    g = container.repo()
    h = Container.repo()
    i = lagom_container[PlayerRepo]
    j = models.Club(1)
    k = make()
`);
    expect(functions[0]!.localTypes).toEqual([
      { name: "a", type: "SqlPlayerRepo" },
      { name: "b", type: "PlayerRepo" },
      { name: "c", type: "Store" },
      { name: "d", type: "PlayerRepo" },
      { name: "e", type: "PlayerRepo" },
      { name: "f", type: "PlayerRepo" },
      { name: "g", type: "", qualifier: "Container.repo" },
      { name: "h", type: "", qualifier: "Container.repo" },
      { name: "i", type: "PlayerRepo" },
      { name: "j", type: "models.Club" },
      // Typed later through `make`'s declared return type.
      { name: "k", type: "", from: "make()" },
    ]);
  });

  it("carries untyped call initializers as `from`, one per distinct call", async () => {
    const { functions } = await extract(`
async def run(path, items):
    p = Patcher.from_file(path)
    q = await load_repo()
    r = build_a()
    r = build_b()
    r = None
    s = build_a()
    s = items[0]
    t = len(items)
    u = build_a()
    u = SqlPlayerRepo()
`);
    expect(functions[0]!.localTypes).toEqual([
      { name: "p", type: "", from: "Patcher.from_file()" },
      { name: "q", type: "", from: "load_repo()", awaited: true },
      { name: "r", type: "", from: "build_a()" },
      { name: "r", type: "", from: "build_b()" },
      // \`s\` is also assigned something untyped, \`t\` from a builtin, and \`u\`
      // from a call and a construction that disagree: none is typed.
    ]);
  });

  it("drops a local reassigned untyped, rebound by a loop or `with … as`, and never re-types a parameter", async () => {
    const { functions } = await extract(`
def run(other, repos, cm, param: PlayerRepo):
    a = SqlPlayerRepo()
    a = other
    b = SqlPlayerRepo()
    for b in repos:
        pass
    c = SqlPlayerRepo()
    with cm() as c:
        pass
    param = SqlPlayerRepo()
    d = foo.get(PlayerRepo)
    e = SqlPlayerRepo()
`);
    expect(functions[0]!.localTypes).toEqual([
      // A container lookup the plugin does not recognise is an untyped call.
      { name: "d", type: "", from: "foo.get()" },
      { name: "e", type: "SqlPlayerRepo" },
    ]);
  });

  it("an annotation declares the type whatever is assigned later", async () => {
    const { functions } = await extract(`
def run(x):
    repo: Optional[PlayerRepo] = None
    repo = x
`);
    expect(functions[0]!.localTypes).toEqual([{ name: "repo", type: "Optional[PlayerRepo]" }]);
  });
});

describe("Python parameter types from comments and docstrings", () => {
  it("reads a PEP 484 function type comment", async () => {
    const { functions } = await extract(`
def run(store, n, *args):
    # type: (ClubStore, int, *str) -> None
    store.go()
`);
    expect(functions[0]!.params.map((p) => p.type)).toEqual(["ClubStore", "int"]);
  });

  it("reads Sphinx, Google and NumPy docstrings, and never overrides an annotation", async () => {
    const { functions } = await extract(`
def sphinx(a, b, c: Real):
    """Doc.

    :param a: first
    :type a: ClubStore
    :param PlayerRepo b: second
    :type c: Ignored
    """

def google(repo, n):
    """Doc.

    Args:
        repo (app.repos.PlayerRepo): the repo
        n (int, optional): count
    """

def numpy(repo, a, b):
    """Doc.

    Parameters
    ----------
    repo : :class:\`~app.repos.PlayerRepo\`
        The repo.
    a, b : Store or None

    Returns
    -------
    x : Ignored
    """
`);
    expect(functions.map((f) => f.params.map((p) => p.type))).toEqual([
      ["ClubStore", "PlayerRepo", "Real"],
      ["app.repos.PlayerRepo", "int"],
      ["app.repos.PlayerRepo", "Store | None", "Store | None"],
    ]);
  });

  it("parses the docstring forms on their own", () => {
    expect([...docstringParamTypes(":type repo: PlayerRepo\n:param Store s: x").entries()]).toEqual([
      ["repo", "PlayerRepo"],
      ["s", "Store"],
    ]);
  });
});

describe("Python injection tokens", () => {
  it("names the dependency a parameter is injected by", () => {
    expect(injectionToken("Depends(get_repo)")).toBe("get_repo");
    expect(injectionToken("fastapi.Depends(deps.get_repo, use_cache=False)")).toBe("get_repo");
    expect(injectionToken("Security(dependency=current_user, scopes=['a'])")).toBe("current_user");
    expect(injectionToken("Provide[Container.repo]")).toBe("Container.repo");
    expect(injectionToken("Provide[app.containers.Container.repo]")).toBe("Container.repo");
    expect(injectionToken('Provide["repo"]')).toBe("repo");
    expect(injectionToken("Closing[Provide[Container.db]]")).toBe("Container.db");
    // The annotation's class is the dependency; a class is no provider token.
    expect(injectionToken("Depends()")).toBeNull();
    expect(injectionToken("Depends(SqlPlayerRepo)")).toBeNull();
    expect(injectionToken("Provider[Container.repo]")).toBeNull();
  });

  it("sets qualifiers from defaults, Annotated metadata and module aliases", async () => {
    const { functions } = await extract(`
RepoDep = Annotated[PlayerRepo, Depends(get_repo)]

def handler(a: PlayerRepo = Depends(get_repo), b: Annotated[PlayerRepo, Depends(get_other)] = None, c: RepoDep = None, d: SqlPlayerRepo = Depends(), e=Provide["repo"]):
    pass
`);
    expect(functions[0]!.params.map((p) => [p.name, p.type, p.qualifier])).toEqual([
      ["a", "PlayerRepo", "get_repo"],
      ["b", "Annotated[PlayerRepo, Depends(get_other)]", "get_other"],
      ["c", "Annotated[PlayerRepo, Depends(get_repo)]", "get_repo"],
      ["d", "SqlPlayerRepo", undefined],
      ["e", null, "repo"],
    ]);
  });
});

describe("Python interfaces", () => {
  it("lists every base, and marks Protocols structural and abstract ABCs nominal interfaces", async () => {
    const { classes } = await extract(`
class Notifier(Protocol):
    def notify(self, msg: str) -> None: ...

class Repo(Generic[T], ABC):
    @abstractmethod
    def find(self, k): ...

class Meta(metaclass=ABCMeta):
    @abc.abstractmethod
    def go(self): ...

class Template(ABC):
    def run(self):
        return 1

class Impl(Mixin, Repo, metaclass=Meta):
    def find(self, k):
        return k
`);
    const view = classes.map((c) => [c.name, c.extends, c.implements, c.kind ?? "class", c.structural ?? false]);
    expect(view).toEqual([
      ["Notifier", "Protocol", [], "interface", true],
      ["Repo", "Generic[T]", ["ABC"], "interface", false],
      ["Meta", null, [], "interface", false],
      // No abstract member: an ordinary, instantiable base class.
      ["Template", "ABC", [], "class", false],
      ["Impl", "Mixin", ["Repo"], "class", false],
    ]);
  });

  it("records ABC virtual subclasses registered in the same file", async () => {
    const { classes } = await extract(`
class Store(ABC):
    @abstractmethod
    def get(self): ...

class Registry:
    pass

@Store.register
class Decorated:
    def get(self): ...

class Called:
    def get(self): ...

class Plugin:
    pass

Store.register(Called)
Registry.register(Plugin)
`);
    const impl = Object.fromEntries(classes.map((c) => [c.name, c.implements]));
    expect(impl).toMatchObject({ Decorated: ["Store"], Called: ["Store"], Plugin: [] });
  });
});

describe("Python chained container lookups", () => {
  it("types the receiver of a call made on a lookup, and only on a lookup", async () => {
    const { functions } = await extract(`
def run(container: Container, foo):
    injector.get(PlayerRepo).find_player(1)
    ServiceLocator.resolve(PlayerRepo).find(2)
    container.repo().save(3)
    foo.get(PlayerRepo).other(4)
`);
    const typed = functions[0]!.calls
      .filter((c) => c.receiverType !== undefined || c.receiverQualifier !== undefined)
      .map((c) => [c.name, c.receiverType, c.receiverQualifier]);
    expect(typed).toEqual([
      ["injector.get(PlayerRepo).find_player", "PlayerRepo", undefined],
      // A noise-named leaf on a typed lookup is a project call, never held back.
      ["ServiceLocator.resolve(PlayerRepo).find", "PlayerRepo", undefined],
      // A provider call names its key alone.
      ["container.repo().save", undefined, "Container.repo"],
    ]);
  });
});

describe("Python container registrations", () => {
  it("binds a FastAPI dependency function to the one class it returns or yields", async () => {
    expect(await bindings(`
def get_repo() -> PlayerRepo:
    return SqlPlayerRepo()

async def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_either(flag):
    if flag:
        return SqlPlayerRepo()
    return TwinRepo()

def get_maybe(flag):
    if flag:
        return None
    return SqlPlayerRepo()

def get_built():
    return build_repo()

class Holder:
    def method(self):
        return SqlPlayerRepo()
`)).toEqual([
      { service: "get_repo", implementation: "SqlPlayerRepo", via: "provider", keyedOnly: true },
      { service: "get_db", implementation: "SessionLocal", via: "provider", keyedOnly: true },
    ]);
  });

  it("records dependency overrides (core keeps a test file's away from production code)", async () => {
    expect(await bindings(`
app.dependency_overrides[get_repo] = lambda: FakeRepo()
app.dependency_overrides[deps.get_db] = get_test_db
app.dependency_overrides[get_settings] = TestSettings
app.dependency_overrides[get_x] = lambda: make()
`)).toEqual([
      { service: "get_repo", implementation: "FakeRepo", via: "dependency_overrides", keyedOnly: true },
      { service: "get_db", implementation: "get_test_db", via: "dependency_overrides", keyedOnly: true },
      { service: "get_settings", implementation: "TestSettings", via: "dependency_overrides", keyedOnly: true },
    ]);
  });

  it("binds dependency-injector providers under both token spellings", async () => {
    expect(await bindings(`
class Container(containers.DeclarativeContainer):
    config = providers.Configuration()
    repo = providers.Factory(SqlPlayerRepo, session=db.provided.session)
    cache = providers.Singleton("app.cache.RedisCache")
    fn = providers.Callable(make_repo)
    dep = providers.Dependency(instance_of=PlayerRepo)
    lazy = providers.Factory(make_repo)
`)).toEqual([
      { service: "Container.repo", implementation: "SqlPlayerRepo", via: "providers.Factory", keyedOnly: true },
      { service: "repo", implementation: "SqlPlayerRepo", via: "providers.Factory", keyedOnly: true },
      { service: "Container.cache", implementation: "RedisCache", via: "providers.Singleton", keyedOnly: true },
      { service: "cache", implementation: "RedisCache", via: "providers.Singleton", keyedOnly: true },
    ]);
  });

  it("binds injector bindings and Module providers, conditional ones included", async () => {
    expect(await bindings(`
def configure(binder):
    if os.environ.get("PAY") == "stripe":
        binder.bind(Gateway, to=StripeGw)
    else:
        binder.bind(Gateway, to=AdyenGw)
    binder.bind(Cache, to=ClassProvider(RedisCache))
    binder.bind(Clock, to=SystemClock())
    binder.bind(Mailer, SmtpMailer)
    binder.bind(Self)
    binder.bind(Same, to=Same)
    sock.bind(("0.0.0.0", 80))

class NotifyModule(Module):
    @singleton
    @provider
    def notifier(self) -> Notifier:
        return SmsNotifier()

    @provider
    def concrete(self) -> SmsNotifier:
        return SmsNotifier()

    @multiprovider
    def many(self) -> List[Notifier]:
        return [SmsNotifier()]
`)).toEqual([
      { service: "Gateway", implementation: "StripeGw", via: "bind" },
      { service: "Gateway", implementation: "AdyenGw", via: "bind" },
      { service: "Cache", implementation: "RedisCache", via: "bind" },
      { service: "Clock", implementation: "SystemClock", via: "bind" },
      { service: "Mailer", implementation: "SmtpMailer", via: "bind" },
      { service: "Notifier", implementation: "SmsNotifier", via: "@provider" },
    ]);
  });
});
