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
    def __init__(self, store: AccountStore, repo: Optional[UserRepo] = None, other=Provide[Container.repo], legacy=None):
        self._accounts = store
        self.repo = repo
        self.made = SqlUserRepo(db)
        self.typed: AccountStore = make()
        self.legacy = legacy  # type: LegacyStore
        self.injected = other
        self.none = None
        self.count = 0
`);
    expect(props(classes[0]!)).toEqual([
      { name: "_accounts", type: "AccountStore" },
      { name: "repo", type: "Optional[UserRepo]" },
      { name: "made", type: "SqlUserRepo" },
      { name: "typed", type: "AccountStore" },
      { name: "legacy", type: "LegacyStore" },
      { name: "injected", type: null, qualifier: "Container.repo" },
    ]);
    expect(classes[0]!.properties[0]!.visibility).toBe("private");
  });

  it("leaves an attribute untyped when any method assigns it something the source does not type", async () => {
    const { classes } = await extract(`
class Svc:
    def __init__(self, fast):
        self.repo = SqlUserRepo()
        if fast:
            self.same = SqlUserRepo()
        else:
            self.same = SqlUserRepo(1)
        if fast:
            self.differ = SqlUserRepo()
        else:
            self.differ = TwinRepo()

    def reset(self, other):
        self.repo = other
`);
    expect(props(classes[0]!)).toEqual([{ name: "same", type: "SqlUserRepo" }]);
  });

  it("keeps a class-level annotation over what __init__ assigns, and ignores static/class methods", async () => {
    const { classes } = await extract(`
class Svc:
    repo: UserRepo

    def __init__(self, repo: SqlUserRepo):
        self.repo = repo

    @classmethod
    def build(cls):
        cls.cache = Cache()
`);
    expect(props(classes[0]!)).toEqual([{ name: "repo", type: "UserRepo" }]);
  });
});

describe("Python locals", () => {
  it("types constructed, annotated, commented, cast and container-fetched locals", async () => {
    const { functions } = await extract(`
def run(container: Container, x):
    a = SqlUserRepo()
    b: UserRepo = make()
    c = x  # type: Store
    d = cast(UserRepo, x)
    e = injector.get(UserRepo)
    f = ServiceLocator.resolve(UserRepo)
    g = container.repo()
    h = Container.repo()
    i = lagom_container[UserRepo]
    j = models.Account(1)
    k = make()
`);
    expect(functions[0]!.localTypes).toEqual([
      { name: "a", type: "SqlUserRepo" },
      { name: "b", type: "UserRepo" },
      { name: "c", type: "Store" },
      { name: "d", type: "UserRepo" },
      { name: "e", type: "UserRepo" },
      { name: "f", type: "UserRepo" },
      { name: "g", type: "", qualifier: "Container.repo" },
      { name: "h", type: "", qualifier: "Container.repo" },
      { name: "i", type: "UserRepo" },
      { name: "j", type: "models.Account" },
    ]);
  });

  it("drops a local reassigned untyped, rebound by a loop or `with … as`, and never re-types a parameter", async () => {
    const { functions } = await extract(`
def run(other, repos, cm, param: UserRepo):
    a = SqlUserRepo()
    a = other
    b = SqlUserRepo()
    for b in repos:
        pass
    c = SqlUserRepo()
    with cm() as c:
        pass
    param = SqlUserRepo()
    d = foo.get(UserRepo)
    e = SqlUserRepo()
`);
    expect(functions[0]!.localTypes).toEqual([{ name: "e", type: "SqlUserRepo" }]);
  });

  it("an annotation declares the type whatever is assigned later", async () => {
    const { functions } = await extract(`
def run(x):
    repo: Optional[UserRepo] = None
    repo = x
`);
    expect(functions[0]!.localTypes).toEqual([{ name: "repo", type: "Optional[UserRepo]" }]);
  });
});

describe("Python parameter types from comments and docstrings", () => {
  it("reads a PEP 484 function type comment", async () => {
    const { functions } = await extract(`
def run(store, n, *args):
    # type: (AccountStore, int, *str) -> None
    store.go()
`);
    expect(functions[0]!.params.map((p) => p.type)).toEqual(["AccountStore", "int"]);
  });

  it("reads Sphinx, Google and NumPy docstrings, and never overrides an annotation", async () => {
    const { functions } = await extract(`
def sphinx(a, b, c: Real):
    """Doc.

    :param a: first
    :type a: AccountStore
    :param UserRepo b: second
    :type c: Ignored
    """

def google(repo, n):
    """Doc.

    Args:
        repo (app.repos.UserRepo): the repo
        n (int, optional): count
    """

def numpy(repo, a, b):
    """Doc.

    Parameters
    ----------
    repo : :class:\`~app.repos.UserRepo\`
        The repo.
    a, b : Store or None

    Returns
    -------
    x : Ignored
    """
`);
    expect(functions.map((f) => f.params.map((p) => p.type))).toEqual([
      ["AccountStore", "UserRepo", "Real"],
      ["app.repos.UserRepo", "int"],
      ["app.repos.UserRepo", "Store | None", "Store | None"],
    ]);
  });

  it("parses the docstring forms on their own", () => {
    expect([...docstringParamTypes(":type repo: UserRepo\n:param Store s: x").entries()]).toEqual([
      ["repo", "UserRepo"],
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
    expect(injectionToken("Depends(SqlUserRepo)")).toBeNull();
    expect(injectionToken("Provider[Container.repo]")).toBeNull();
  });

  it("sets qualifiers from defaults, Annotated metadata and module aliases", async () => {
    const { functions } = await extract(`
RepoDep = Annotated[UserRepo, Depends(get_repo)]

def handler(a: UserRepo = Depends(get_repo), b: Annotated[UserRepo, Depends(get_other)] = None, c: RepoDep = None, d: SqlUserRepo = Depends(), e=Provide["repo"]):
    pass
`);
    expect(functions[0]!.params.map((p) => [p.name, p.type, p.qualifier])).toEqual([
      ["a", "UserRepo", "get_repo"],
      ["b", "Annotated[UserRepo, Depends(get_other)]", "get_other"],
      ["c", "Annotated[UserRepo, Depends(get_repo)]", "get_repo"],
      ["d", "SqlUserRepo", undefined],
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
    injector.get(UserRepo).find_user(1)
    ServiceLocator.resolve(UserRepo).find(2)
    container.repo().save(3)
    foo.get(UserRepo).other(4)
`);
    const typed = functions[0]!.calls
      .filter((c) => c.receiverType !== undefined || c.receiverQualifier !== undefined)
      .map((c) => [c.name, c.receiverType, c.receiverQualifier]);
    expect(typed).toEqual([
      ["injector.get(UserRepo).find_user", "UserRepo", undefined],
      // A noise-named leaf on a typed lookup is a project call, never held back.
      ["ServiceLocator.resolve(UserRepo).find", "UserRepo", undefined],
      // A provider call names its key alone.
      ["container.repo().save", undefined, "Container.repo"],
    ]);
  });
});

describe("Python container registrations", () => {
  it("binds a FastAPI dependency function to the one class it returns or yields", async () => {
    expect(await bindings(`
def get_repo() -> UserRepo:
    return SqlUserRepo()

async def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_either(flag):
    if flag:
        return SqlUserRepo()
    return TwinRepo()

def get_maybe(flag):
    if flag:
        return None
    return SqlUserRepo()

def get_built():
    return build_repo()

class Holder:
    def method(self):
        return SqlUserRepo()
`)).toEqual([
      { service: "get_repo", implementation: "SqlUserRepo", via: "provider", keyedOnly: true },
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
    repo = providers.Factory(SqlUserRepo, session=db.provided.session)
    cache = providers.Singleton("app.cache.RedisCache")
    fn = providers.Callable(make_repo)
    dep = providers.Dependency(instance_of=UserRepo)
    lazy = providers.Factory(make_repo)
`)).toEqual([
      { service: "Container.repo", implementation: "SqlUserRepo", via: "providers.Factory", keyedOnly: true },
      { service: "repo", implementation: "SqlUserRepo", via: "providers.Factory", keyedOnly: true },
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
