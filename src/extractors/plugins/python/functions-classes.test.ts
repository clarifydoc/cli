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
`);
    const rt = Object.fromEntries(functions.map((f) => [f.name, f.returnType]));
    expect(rt).toEqual({ player: "Player", db: "models.Database", mixed: null, typed: "Club", not_a_fixture: null });
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
  });
});
