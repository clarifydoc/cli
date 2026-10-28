import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonExtractor } from "./functions-classes.js";

async function extract(src: string) {
  const tree = await parseSource(src, "python" as never, "a.py");
  const ex = new PythonExtractor();
  return { functions: ex.extractFunctions(tree, src), classes: ex.extractClasses(tree, src) };
}

describe("Python functions", () => {
  it("keeps every parameter shape with its name, type and default", async () => {
    const { functions } = await extract(`
async def create(player_id: int, body: PlayerCreate, q: str | None = Query(None), current=Depends(get_current_user), plain, *args: int, **kwargs):
    pass
`);
    expect(functions[0]!.params).toEqual([
      { name: "player_id", type: "int", defaultValue: null },
      { name: "body", type: "PlayerCreate", defaultValue: null },
      { name: "q", type: "str | None", defaultValue: "Query(None)" },
      { name: "current", type: null, defaultValue: "Depends(get_current_user)", qualifier: "get_current_user" },
      { name: "plain", type: null, defaultValue: null },
    ]);
  });

  it("calls the module function a dependency factory hands out by name, never a local it returns", async () => {
    const { functions } = await extract(`
def get_current_player_authorizer(*, required: bool = True):
    return _get_current_player if required else _get_optional_player

def get_squad(size):
    squad = make_squad(size)
    return squad

def _get_current_player(token: str):
    return token

def _get_optional_player(token: str):
    return None
`);
    expect(functions.find((f) => f.name === "get_current_player_authorizer")!.calls.map((c) => c.name)).toEqual(["_get_current_player", "_get_optional_player"]);
    expect(functions.find((f) => f.name === "get_squad")!.calls.map((c) => c.name)).toEqual(["make_squad"]);
  });

  it("calls the dependencies a signature asks for: by name when named as a callable, the factory when built by one", async () => {
    const { functions } = await extract(`
async def get_player_from_path(
    player_id: int = Path(..., ge=1),
    club: Club = Depends(clubs.get_club_from_path),
    repo: Annotated[PlayersRepo, Depends(get_repository(PlayersRepo))] = None,
):
    return await repo.get(player_id, club)
`);
    expect(functions[0]!.calls.filter((c) => c.name !== "repo.get").map((c) => [c.name, c.line, c.routeParamsByName ?? false])).toEqual([
      ["clubs.get_club_from_path", 4, true],
      ["get_repository", 5, false],
    ]);
  });

  it("drops self/cls and records what the body reads off request", async () => {
    const { classes, functions } = await extract(`
class ReportView(View):
    def post(self, request, pk):
        title = request.POST["title"]
        page = request.GET.get("page", type=int)
        raw = request.data
        return None

def helper(x):
    return x
`);
    const post = classes[0]!.methods[0]!;
    expect(post.params).toEqual([
      { name: "request", type: null, defaultValue: null },
      { name: "pk", type: null, defaultValue: null },
    ]);
    expect(post.requestAccess).toEqual([
      { name: "title", type: null, binding: "form" },
      { name: "page", type: "int", binding: "query" },
      { name: "body", type: null, binding: "body" },
    ]);
    expect(functions[0]!.requestAccess).toBeUndefined();
  });
});

describe("Python nested functions", () => {
  it("reports a def inside a module-level if / try block as a module function (real-repo FP)", async () => {
    const { functions } = await extract(`
import sys

if args.compare:
    def write_pairs(title, pairs):
        def row(p):
            return p.club
        print(title, [row(p) for p in pairs])
    write_pairs("moved", moved)

try:
    from league import fast_table
except ImportError:
    def fast_table(rows):
        return sorted(rows)
`);
    expect(functions.filter((f) => f.name !== "<setup>").map((f) => `${f.name}@${f.line} ${f.isExported ? "exported" : "-"}`)).toEqual([
      "write_pairs@5 exported",
      "row@6 -",
      "fast_table@14 exported",
    ]);
  });

  it("reports a def nested in a function or a method as a function of its own, with its calls (real-repo FP)", async () => {
    const { functions, classes } = await extract(`
def repeat_every(seconds):
    def decorator(func):
        @wraps(func)
        async def wrapped():
            async def loop():
                await func()
                await asyncio.sleep(seconds)
            asyncio.ensure_future(loop())
        return wrapped
    return decorator

class Scout:
    def fetch(self, session):
        def get_pages():
            return session.get(CATALOG_URL, timeout=3)
        if self.enabled:
            for page in get_pages():
                yield page
`);
    expect(functions.map((f) => `${f.name}@${f.line} ${f.isExported ? "exported" : "-"} ${f.calls.map((c) => c.name).join(",")}`)).toEqual([
      "repeat_every@2 exported ",
      "decorator@3 - wraps",
      "wrapped@5 - asyncio.ensure_future,loop",
      "loop@6 - func,asyncio.sleep",
      "get_pages@15 - session.get,CATALOG_URL",
    ]);
    expect(functions.find((f) => f.name === "wrapped")!.decorators).toEqual(["wraps(func)"]);
    expect(classes[0]!.methods.map((m) => m.name)).toEqual(["fetch"]);
  });
});

describe("Python classes", () => {
  it("emits annotated attributes as properties with Field(...) kept as a decorator", async () => {
    const { classes } = await extract(`
class AdminPlayerCreate(PlayerCreate, metaclass=Meta):
    display_name: str = Field(..., alias="player_name")
    nick: Optional[str] = None
    age: int | None
    tags: list[str] = []
    address: Address
    role: PlayerRole = PlayerRole.PLAYER
    code: str = Field(alias="c")
    note: str = Field(None, max_length=10)
    _hidden: int = 0
    kind: ClassVar[str] = "admin"
    model_config = ConfigDict(extra="forbid")
    counter = 0

    class Config:
        from_attributes = True
`);
    const cls = classes[0]!;
    expect(cls.extends).toBe("PlayerCreate");
    expect(cls.properties).toEqual([
      { name: "display_name", type: "str", visibility: "public", isStatic: false, isReadonly: false, decorators: ['Field(..., alias="player_name")'], isRequired: true },
      { name: "nick", type: "Optional[str]", visibility: "public", isStatic: false, isReadonly: false, isRequired: false },
      { name: "age", type: "int | None", visibility: "public", isStatic: false, isReadonly: false, isRequired: false },
      { name: "tags", type: "list[str]", visibility: "public", isStatic: false, isReadonly: false, isRequired: false },
      { name: "address", type: "Address", visibility: "public", isStatic: false, isReadonly: false, isRequired: true },
      { name: "role", type: "PlayerRole", visibility: "public", isStatic: false, isReadonly: false, isRequired: false },
      { name: "code", type: "str", visibility: "public", isStatic: false, isReadonly: false, decorators: ['Field(alias="c")'], isRequired: true },
      { name: "note", type: "str", visibility: "public", isStatic: false, isReadonly: false, decorators: ['Field(None, max_length=10)'], isRequired: false },
      { name: "_hidden", type: "int", visibility: "private", isStatic: false, isReadonly: false, isRequired: false },
      { name: "kind", type: "ClassVar[str]", visibility: "public", isStatic: true, isReadonly: false, isRequired: false },
    ]);
  });

  it("leaves ORM column and relationship attributes to the entity extractor", async () => {
    const { classes } = await extract(`
class Player(Base):
    __tablename__ = "players"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(120))
    games: Mapped[list["Game"]] = relationship(back_populates="scout")
    nickname: str = "anon"
`);
    expect(classes[0]!.properties.map((p) => p.name)).toEqual(["nickname"]);
  });
});

describe("nested classes and fixtures", () => {
  it("extracts a class a function builds, with its methods and their calls (real-repo FP)", async () => {
    const { classes } = await extract(`
def get_transfer_form(a_type, b_type):

    class FormMetaclass(forms.models.ModelFormMetaclass):
        def __new__(mcs, name, bases, attrs):
            return super().__new__(mcs, name, bases, attrs)

    class _TransferForm(TransferForm, metaclass=FormMetaclass):
        class Meta:
            model = Transfer

        def clean(self):
            validate_window(self.instance)

    return _TransferForm
`);
    expect(classes.map((c) => `${c.name}:${c.methods.map((m) => m.name).join(",")}`)).toEqual(["FormMetaclass:__new__", "_TransferForm:clean"]);
    expect(classes[1]!.methods[0]!.calls.map((c) => c.name)).toContain("validate_window");
  });

  it("extracts a nested class with methods, never a configuration class", async () => {
    const { classes } = await extract(`
class Outer:
    class Inner:
        def go(self):
            return 2
    class Meta:
        ordering = ["id"]
    def make(self):
        return Outer.Inner()
`);
    expect(classes.map((c) => `${c.name}[${c.methods.map((m) => m.name)}]`)).toEqual(["Outer[make]", "Inner[go]"]);
  });

  it("types an unannotated fixture by the one class it returns or yields", async () => {
    const { functions } = await extract(`
import pytest

@pytest.fixture
def player():
    return Player(name="a")

@pytest.fixture(scope="module")
def db():
    conn = models.Database()
    yield models.Database()

@pytest.fixture
def mixed(flag):
    if flag:
        return Player()
    return Admin()

@pytest.fixture
def typed() -> Club:
    return make()

def not_a_fixture():
    return Player()

def generator():
    yield Player()
`);
    const rt = Object.fromEntries(functions.map((f) => [f.name, f.returnType]));
    // Any unannotated function returning one class is typed by it; only a fixture's `yield` is what it gives.
    expect(rt).toEqual({ player: "Player", db: "models.Database", mixed: null, typed: "Club", not_a_fixture: "Player", generator: null });
  });
});

describe("Python properties as typed members", () => {
  it("types a property by its annotation, the class it builds, the attribute it returns, or the chain it returns", async () => {
    const { classes } = await extract(`
class LeagueController(BaseController):
    _repos: AllRepositories | None = None

    @property
    def repos(self):
        if not self._repos:
            self._repos = AllRepositories(self.session)
        return self._repos

    @cached_property
    def repo(self):
        return self.repos.players

    @cached_property
    def mixins(self):
        return HttpRepo[SavePlayer, Player](self.repo, self.logger)

    @property
    def squad(self) -> SquadService:
        return self.make_squad()
`);
    const props = Object.fromEntries(classes[0]!.properties.map((p) => [p.name, `${p.type ?? "-"} ${p.from ?? ""}`.trim()]));
    expect(props).toMatchObject({
      repos: "AllRepositories | None",
      repo: "- self.repos.players",
      mixins: "HttpRepo",
      squad: "SquadService",
    });
    // What the wrapper was built with, positional only: a project pass follows the repository into it.
    expect(classes[0]!.properties.find((p) => p.name === "mixins")?.constructedWith).toEqual(["self.repo", "self.logger"]);
  });

  it("keeps a chain on a typed constructor parameter, and what a wrapper annotated as its own class is built with", async () => {
    const { classes } = await extract(`
class SquadService:
    def __init__(self, repos: AllRepositories, size):
        self.repos = repos
        self.players = repos.squad_players
        self.loans = size.loans

    def refresh(self, plain):
        self.coaches = plain.coaches

class SquadController:
    @cached_property
    def mixins(self) -> HttpRepo[PlayerCreate, PlayerOut]:
        return HttpRepo(self.repo, self.logger)
`);
    const props = Object.fromEntries(classes[0]!.properties.map((p) => [p.name, `${p.type ?? "-"} ${p.from ?? ""}`.trim()]));
    // An untyped parameter's chain, or one outside the constructor, says nothing.
    expect(props).toEqual({ repos: "AllRepositories", players: "- repos.squad_players" });
    expect(classes[1]!.properties.find((p) => p.name === "mixins")?.constructedWith).toEqual(["self.repo", "self.logger"]);
  });
});

describe("Python constructor parameters held as classes", () => {
  it("records the parameter a class-typed attribute is assigned from, and nothing for instances", async () => {
    const { classes } = await extract(`
class ClubRepository:
    def __init__(self, session: Session, model: type[Club], schema: Type[ClubOut]):
        self.session = session
        self.model = model
        self.schema = schema
`);
    expect(classes[0]!.properties.map((p) => [p.name, p.assignedFrom ?? null])).toEqual([
      ["session", null],
      ["model", "model"],
      ["schema", "schema"],
    ]);
  });

  it("names the attribute an untyped parameter is stored in, unchanged, and nothing for a typed or reworked one", async () => {
    const { classes } = await extract(`
class MatchRepository:
    def __init__(self, session: Session, model, table_name, limit):
        self.session = session
        self.model = model
        self.table = table_name.lower()
        self.limit = limit
        self.limit = limit or 10
`);
    const init = classes[0]!.methods.find((m) => m.name === "__init__")!;
    expect(init.params.map((p) => [p.name, p.assignedTo ?? null])).toEqual([
      ["session", null],
      ["model", "model"],
      ["table_name", null],
      ["limit", null],
    ]);
  });
});


describe("Python abstract methods", () => {
  it("marks @abstractmethod members, and a non-ABC class declaring one as abstract", async () => {
    const { classes } = await extract(`
from abc import ABC, abstractmethod

class Notifier(ABC):
    def notify_club(self, c):
        self.send(c)

    @abstractmethod
    def send(self, c): ...

class BulkNotifier(Notifier):
    @abstractmethod
    def flush(self): ...
`);
    const notifier = classes.find((c) => c.name === "Notifier")!;
    expect(notifier.kind).toBe("interface");
    expect(notifier.methods.find((m) => m.name === "send")!.abstract).toBe(true);
    expect(notifier.methods.find((m) => m.name === "notify_club")!.abstract).toBeUndefined();
    expect(classes.find((c) => c.name === "BulkNotifier")!.abstract).toBe(true);
  });
});
