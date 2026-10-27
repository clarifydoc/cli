import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonDataSourceExtractor } from "./data-sources.js";

async function apiCallsOf(src: string) {
  const tree = await parseSource(src, "python" as never, "x.py");
  return new PythonDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "api-call")
    .map((d) => ({ name: d.name, target: d.target, line: d.line }));
}

describe("Python outbound HTTP calls", () => {
  it("reads a module verb call and its literal URL", async () => {
    const calls = await apiCallsOf(
      ["import requests, httpx", 'requests.get("https://api.example.com/v1/balls")', 'httpx.post(f"{BASE}/api/x")'].join("\n"),
    );
    expect(calls).toEqual([
      { name: "get", target: "https://api.example.com/v1/balls", line: 2 },
      { name: "post", target: "{BASE}/api/x", line: 3 },
    ]);
  });

  it("reads a client's call whose URL the function builds in a local (real-repo FP)", async () => {
    const calls = await apiCallsOf([
      "import httpx",
      "async def standings(season):",
      "    async with httpx.AsyncClient() as client:",
      '        url = f"http://{BASE_URL}/api/standings"',
      "        res = await client.get(url, params={'season': season})",
      "        return res.json()",
    ].join("\n"));
    expect(calls).toEqual([{ name: "get", target: "http://{BASE_URL}/api/standings", line: 5 }]);
  });

  it("keeps every literal of a long concatenated URL (real-repo FP)", async () => {
    const calls = await apiCallsOf([
      "import requests",
      "def page(base_url, limit, offset):",
      '    url = base_url + "/league/v2/matches?query=season:*&_limit=" + str(limit) + "&_offset=" + str(offset) + "&withKits=true"',
      "    return requests.get(url)",
    ].join("\n"));
    expect(calls).toEqual([{ name: "get", target: "{}/league/v2/matches?query=season:*&_limit={}&_offset={}&withKits=true", line: 4 }]);
  });

  it("keeps a call whose URL is a variable, without inventing a URL from its name", async () => {
    expect(await apiCallsOf("requests.get(url)")).toEqual([{ name: "get", target: null, line: 1 }]);
  });

  it("reads requests.request(METHOD, url) as that method", async () => {
    expect(await apiCallsOf('requests.request("DELETE", "/api/balls/1")')).toEqual([
      { name: "delete", target: "/api/balls/1", line: 1 },
    ]);
  });

  it("accepts a session or client receiver only with a URL-shaped argument", async () => {
    const calls = await apiCallsOf(['self.session.get("/api/players")', 'cache_client.get("players")'].join("\n"));
    expect(calls).toEqual([{ name: "get", target: "/api/players", line: 1 }]);
  });

  it("reads a verb on a session the enclosing function made as HTTP, never as a database read (real-repo FP)", async () => {
    const src = [
      "import requests",
      "def get_league_tables():",
      "    session = requests.Session()",
      "    def get_pages():",
      "        first = session.get(settings.LEAGUE_TABLE_URL, timeout=3).json()",
      "        yield first",
      "    return list(get_pages())",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).map((d) => `${d.kind} ${d.name} ${d.target}`);
    // The settings URL is another module's value: a hole the project pass fills.
    expect(rows).toEqual(["api-call get ${settings.LEAGUE_TABLE_URL}"]);
  });

  it("is not fooled by text that merely contains a client module's name", async () => {
    const src = [
      'pending_requests.get("task_type")',
      "httpx.Response(200)",
      'httpx.Request("GET")',
      "httpx.codes.is_server_error(code)",
      'raise httpx.ConnectError("no hostname")',
      'task.requests.filter(task_type="x")',
    ].join("\n");
    expect(await apiCallsOf(src)).toEqual([]);
  });

  it("does not emit a second call for a chain hanging off the response", async () => {
    const calls = await apiCallsOf('requests.get("/api/x").json().get("page")');
    expect(calls).toEqual([{ name: "get", target: "/api/x", line: 1 }]);
  });
});

describe("Python database calls", () => {
  const dbCallsOf = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database").map((d) => d.name);
  };

  it("reads generic verbs on a datastore-shaped chain", async () => {
    expect(await dbCallsOf([
      'cursor.execute("SELECT 1")',
      'self.conn.execute("DELETE FROM t")',
      "con.execute(\"SELECT Value FROM league_setting WHERE Key = ?\", (k,))",
      "Car.objects.filter(paid=True)",
      "session.query(Player).filter(Player.id == 1).first()",
      "Player.query.filter_by(name=n)",
      "db.players.find({})",
      "player.cars.all()",
      "car.save()",
    ].join("\n"))).toEqual([
      "cursor.execute",
      "self.conn.execute",
      "con.execute",
      "Car.objects.filter",
      "session.query(Player).filter(Player.id == 1).first",
      "session.query(Player).filter",
      "session.query",
      "Player.query.filter_by",
      "db.players.find",
      "player.cars.all",
      "car.save",
    ]);
  });

  it("names the model of a Django manager or a Flask-SQLAlchemy query, not the manager", async () => {
    const src = ["Car.objects.filter(paid=True).first()", "Player.query.filter_by(name=n)", "cars.objects.all()"].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database").map((d) => `${d.name} → ${d.entity ?? "-"}`);
    expect(rows).toEqual(["Car.objects.filter(paid=True).first → Car", "Car.objects.filter → Car", "Player.query.filter_by → Player", "cars.objects.all → -"]);
  });

  it("reads every verb on a model's manager, its writes as writes (real-repo FP)", async () => {
    const src = [
      "club = Club.objects.get(pk=pk)",
      "kinds = ContentType.objects.get_for_model(Club)",
      "rows = Club.objects.annotate(players=Count('player'))",
      "Fixture.objects.bulk_update(fixtures, ['kickoff'])",
      "Player.objects.using(alias).filter(club=club).update(active=False)",
      "Referee.objects.create(name=n)",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database" && /^[A-Z]\w*\.objects\.\w+$|objects\.using.*update$/.test(d.name)).map((d) => `${d.entity} ${d.access}`);
    expect(rows).toEqual(["Club read", "ContentType read", "Club read", "Fixture write", "Player write", "Player read", "Referee write"]);
  });

  it("leaves interpreters, strings, XML trees and arrays alone", async () => {
    // code-scalpel: every one of these was a "database" access.
    expect(await dbCallsOf([
      "interp.execute(ir)",
      "SymbolicInterpreter().execute(code)",
      'line.find("TODO")',
      'root.find("BugInstance")',
      "ast.filter(javalang.tree.MethodDeclaration)",
      "mask.all()",
    ].join("\n"))).toEqual([]);
  });
});

describe("Python raw SQL in migrations and annotations", () => {
  it("reads the data statements of RunSQL, RawSQL and Alembic op.execute, never their DDL (real-repo FP)", async () => {
    const src = [
      "from alembic import op",
      "import sqlalchemy as sa",
      "from django.db import migrations",
      "from django.db.models.expressions import RawSQL",
      "",
      "def upgrade():",
      '    op.execute("UPDATE clubs SET is_relegated = FALSE")',
      '    op.execute(sa.text("DELETE FROM club_kits WHERE kit_id IS NULL"))',
      '    op.execute("CREATE INDEX ix_clubs_name ON clubs (name)")',
      '    op.execute(f"UPDATE {table} SET name = lower(name)")',
      "",
      "operations = [",
      "    migrations.RunSQL(\"INSERT INTO league_group (SELECT id, name, '' AS description FROM auth_group)\"),",
      '    migrations.RunSQL(["UPDATE players SET captain = false", "DROP TABLE old_players"], reverse_sql=migrations.RunSQL.noop),',
      "]",
      "player_count = RawSQL(\"SELECT COUNT(DISTINCT m2m.player_id) FROM league_club_players m2m WHERE m2m.club_id = 1\", ())",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "0006_league_group.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database").map((d) => `${d.name} ${d.entity} ${d.access} @${d.line}`);
    expect(rows).toEqual([
      "Alembic: execute clubs write @7",
      "Alembic: execute club_kits write @8",
      "Django: RunSQL league_group write @13",
      "Django: RunSQL players write @14",
      "Django: RawSQL league_club_players read @16",
    ]);
  });
});

describe("Python URLs and SQL held in locals", () => {
  const rows = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor().extract(tree, src).map((d) => [d.kind, d.target, d.entity ?? null, d.access ?? null]);
  };

  it("reads an HTTP call's URL from a local assigned once", async () => {
    expect(await rows([
      "def sync(player_id):",
      '    url = f"{BASE}/players/{player_id}"',
      "    requests.get(url)",
      "    requests.post(BASE_URL + \"/players\")",
    ].join("\n"))).toEqual([["api-call", "{BASE}/players/{player_id}", null, null], ["api-call", "{}/players", null, null]]);
  });

  it("fills an f-string hole naming a local base the function builds (real-repo FP)", async () => {
    expect(await rows([
      "def test_club_history(client, club):",
      '    base = f"/api/clubs/{club[\'id\']}"',
      '    client.get(f"{base}/fixtures")',
      '    client.get(f"{base}/players/{player_id}")',
    ].join("\n"))).toEqual([
      ["api-call", "/api/clubs/{club['id']}/fixtures", null, null],
      ["api-call", "/api/clubs/{club['id']}/players/{player_id}", null, null],
    ]);
  });

  it("reads the table and the verb from raw SQL, literal or local", async () => {
    expect(await rows([
      "def report(cursor, n):",
      '    cursor.execute("SELECT id FROM cars WHERE total > %s", (n,))',
      '    sql = "UPDATE drivers SET flagged = 1 WHERE id = %s"',
      "    cursor.execute(sql, (n,))",
      '    session.execute(text("DELETE FROM sessions WHERE expired"))',
    ].join("\n"))).toEqual([
      ["database", "cars", "cars", "read"],
      ["database", "drivers", "drivers", "write"],
      ["database", "sessions", "sessions", "write"],
    ]);
  });

  it("leaves a local assigned twice alone", async () => {
    expect(await rows([
      "def f(cursor, a):",
      '    sql = "SELECT * FROM a"',
      "    if a:",
      '        sql = "SELECT * FROM b"',
      "    cursor.execute(sql)",
    ].join("\n"))).toEqual([["database", null, null, null]]);
  });
});

describe("Python data access — vector stores", () => {
  it("reads a Qdrant client's collection operations and nothing from an API SDK", async () => {
    const src = `from openai import OpenAI
from qdrant_client import QdrantClient

client = OpenAI()
qdrant = QdrantClient(url="http://qdrant:6333")

def embed(text):
    r = client.embeddings.create(model="m", input=text)
    qdrant.upsert(collection_name="chunks", points=[])
    return qdrant.search(collection_name="chunks", query_vector=r, limit=5)
`;
    const tree = await parseSource(src, "python" as never, "x.py");
    const ds = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
    expect(ds.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["qdrant.upsert", "chunks", "write"],
      ["qdrant.search", "chunks", "read"],
    ]);
  });
});

describe("Python api-call — the json body", () => {
  it("types a json= dict literal or a local bound to one", async () => {
    const src = `import requests

def create(name):
    payload = {"title": "t", "count": 2, **extra}
    requests.post("/api/balls", json={"name": name, "price": 9.5, "tags": ["a"], "active": True})
    requests.put("/api/balls/1", json=payload)
`;
    const tree = await parseSource(src, "python" as never, "x.py");
    const calls = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.requestBody)).toEqual([
      { type: "object", properties: { name: {}, price: { type: "number" }, tags: { type: "array", items: { type: "string" } }, active: { type: "boolean" } } },
      { type: "object", properties: { title: { type: "string" }, count: { type: "integer" } }, additionalProperties: true },
    ]);
  });
});

describe("Python api-call — a base the file states", () => {
  const rows = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor()
      .extract(tree, src)
      .filter((d) => d.kind === "api-call")
      .map((d) => `${d.name} ${d.target}${d.baseRef ? ` @ ${d.baseRef.key}` : ""}`);
  };

  it("keeps the host of a base the class assigns self once", async () => {
    expect(await rows([
      "import requests",
      "class LeagueClient:",
      '    season_url = "https://stats.example.com/seasons/"',
      "    def __init__(self, domain):",
      '        self.base_url = f"https://{domain}/rest/api/2"',
      "    def fixtures(self, club_id):",
      '        url = f"{self.base_url}/clubs/{club_id}/fixtures"',
      "        return requests.get(url)",
      "    def season(self):",
      '        return requests.get(f"{self.season_url}?year=2024")',
      "    def standings(self):",
      '        return requests.get(f"{self.other_url}/standings")',
    ].join("\n"))).toEqual([
      "get /rest/api/2/clubs/{club_id}/fixtures @ https://{domain}",
      "get /seasons?year=2024 @ https://stats.example.com",
      "get {self.other_url}/standings",
    ]);
  });

  it("marks a Locust user's request as behind the host the run is started against (real-repo FP)", async () => {
    const src = ["from locust import HttpUser, task", "class Fan(HttpUser):", "    @task", "    def home(self):", '        self.client.get("/")', '        self.client.get("/api/fixtures")'].join("\n");
    const tree = await parseSource(src, "python" as never, "locustfile.py");
    const calls = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => `${c.target} ${c.baseExpr}`)).toEqual(["/ self.client", "/api/fixtures self.client"]);
  });

  it("writes out an app path a test class states once (real-repo FP)", async () => {
    expect(await rows([
      "class TestLeagueConfig(APITestCase):",
      '    ENDPOINT = "/api/config/"',
      "    def test_update(self):",
      '        self.client.patch(f"{self.ENDPOINT}1/", {"name": "x"})',
    ].join("\n"))).toEqual(["patch /api/config/1/"]);
  });

  it("keeps the host of a module constant, unless it is assigned twice or rebound locally", async () => {
    expect(await rows([
      "import requests",
      'GARAGE_URL = "https://garage.example.com/api"',
      'PITS_URL = "https://pits.example.com"',
      'PITS_URL = "https://pits.example.org"',
      'requests.get(f"{GARAGE_URL}/cars")',
      'requests.get(f"{PITS_URL}/stops")',
      "def tyres(GARAGE_URL):",
      '    requests.get(f"{GARAGE_URL}/tyres")',
    ].join("\n"))).toEqual([
      "get /api/cars @ https://garage.example.com",
      // Two values: a hole the project pass leaves for the call-origin pass.
      "get ${PITS_URL}/stops",
      "get {GARAGE_URL}/tyres",
    ]);
  });
});

describe("Python api-call — urllib", () => {
  const rows = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor()
      .extract(tree, src)
      .filter((d) => d.kind === "api-call")
      .map((d) => `${d.name} ${d.target}@${d.line}`);
  };

  it("reads urlopen of a URL or of a Request, with the Request's method or body", async () => {
    expect(await rows([
      "import urllib.request",
      "from urllib.request import Request, urlopen",
      "def upload(api_url, body):",
      "    req = Request(f'{api_url}/files/kits', data=body, method='PUT')",
      "    return urlopen(req, timeout=30)",
      "def scores():",
      '    urllib.request.urlopen(urllib.request.Request("https://scores.example.com/live", headers={"A": "b"}))',
      '    urlopen("https://scores.example.com/table", b"x=1")',
      "    urlopen(url)",
    ].join("\n"))).toEqual([
      "put {api_url}/files/kits@5",
      "get https://scores.example.com/live@7",
      "post https://scores.example.com/table@8",
      "get null@9",
    ]);
  });

  it("leaves a urlopen that is not urllib's alone", async () => {
    expect(await rows('class Pitch:\n    def urlopen(self, x): pass\nPitch().urlopen("/x")')).toEqual([]);
  });
});

describe("Python stored procedures", () => {
  it("names the routine of a DB-API callproc and of an EXEC / CALL statement", async () => {
    const src = `def sign(conn, pid):
    cur = conn.cursor()
    cur.callproc("usp_SignPlayer", [pid])
    cur.execute("EXEC dbo.usp_NotifyAgent %s", (pid,))
    cur.execute("CALL league.close_window(%s)", (pid,))
    cur.execute("SELECT id FROM players WHERE id = %s", (pid,))
`;
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database" && !d.name.includes(".objects."));
    expect(rows.map((d) => `${d.target} ${d.routine ? "routine" : d.entity}`)).toEqual([
      "usp_SignPlayer routine",
      "dbo.usp_NotifyAgent routine",
      "league.close_window routine",
      "players players",
    ]);
  });
});

describe("Python rows saved through the variable holding them", () => {
  it("takes the model the variable was built from, and never names a table after the variable", async () => {
    const src = [
      "class ClubTests(TestCase):",
      "    def setUp(self):",
      "        self.club1 = Club.objects.create(name='Rovers')",
      "        self.match1 = make_match()",
      "    def test_rename(self):",
      "        self.club1.save()",
      "        self.match1.save()",
      "        player = Player(name='Ann')",
      "        player.save()",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database" && !d.name.includes(".objects."));
    expect(rows.map((d) => [d.name, d.entity ?? null, d.receiverIsInstance ?? false])).toEqual([
      ["self.club1.save", "Club", false],
      ["self.match1.save", null, true],
      ["player.save", "Player", false],
    ]);
  });
});

describe("Python querysets held in a variable or attribute", () => {
  it("takes the model the queryset was assigned, and never names a table `queryset` (real-repo FP)", async () => {
    const src = [
      "class BulkEditView:",
      "    queryset = None",
      "    def post(self, request):",
      "        objs = self.queryset.filter(pk__in=request.POST.getlist('pk'))",
      "class ClubListView:",
      "    queryset = Club.objects.all()",
      "    def get(self, request):",
      "        return self.queryset.filter(active=True)",
      "def fixtures_of(league):",
      "    fixture_qs = Fixture.objects.filter(league=league)",
      "    return fixture_qs.filter(played=False)",
      "class SquadView:",
      "    def get_children(self, request, parent):",
      "        return self.child_model.objects.restrict(request.user, 'view').filter(club=parent)",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database" && !/^[A-Z]\w*\.objects\./.test(d.name));
    expect(rows.map((d) => [d.name, d.entity ?? null, d.receiverIsInstance ?? false])).toEqual([
      ["self.queryset.filter", null, true],
      ["self.queryset.filter", null, true],
      ["fixture_qs.filter", "Fixture", false],
      ["self.child_model.objects.restrict(request.user, 'view').filter", null, true],
    ]);
  });
});

describe("Python SQLAlchemy statements", () => {
  const rowsOf = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database")
      .map((d) => [d.name, d.entity ?? d.entityAttribute ?? null, d.access ?? null]);
  };

  it("names the model the statement handed to the session selects or writes", async () => {
    expect(await rowsOf([
      "import sqlalchemy as sa",
      "from sqlalchemy import select, update",
      "def clubs(session):",
      "    return session.scalars(select(Club).where(Club.id == 1)).all()",
      "def rename(session):",
      "    session.execute(update(models.Club).values(name='x'))",
      "def players(db):",
      "    return db.query(Player.id).all()",
    ].join("\n"))).toEqual([
      ["session.scalars(select(Club).where(Club.id == 1)).all", "Club", "read"],
      ["session.scalars", "Club", "read"],
      ["session.execute", "Club", "write"],
      ["db.query(Player.id).all", "Player", "read"],
      ["db.query", "Player", "read"],
    ]);
  });

  it("follows a local the function builds the statement in, and refuses two models", async () => {
    expect(await rowsOf([
      "def search(self, params):",
      "    q = sa.select(Match).filter(Match.played.is_(True))",
      "    q = q.filter_by(league=params.league)",
      "    q = self._order(q, params)",
      "    return self.session.execute(q).scalars().all()",
      "def mixed(self, home):",
      "    q = select(Club) if home else select(Player)",
      "    stmt = select(Club)",
      "    if home:",
      "        stmt = select(Player)",
      "    return self.session.execute(stmt)",
    ].join("\n")).then((rows) => rows.filter((r) => /execute/.test(r[0]!)))).toEqual([
      ["self.session.execute(q).scalars().all", "Match", "read"],
      ["self.session.execute", "Match", "read"],
      ["self.session.execute", null, null],
    ]);
  });

  it("reports a model held by an attribute of the instance as that attribute", async () => {
    expect(await rowsOf([
      "class Repo:",
      "    def all(self):",
      "        return self.session.execute(sa.select(self.model).filter(self.model.active)).scalars().all()",
      "    def one(self, db, id):",
      "        return db.query(self.model).get(id)",
    ].join("\n"))).toEqual([
      ["self.session.execute(sa.select(self.model).filter(self.model.active)).scalars().all", "model", "read"],
      ["self.session.execute", "model", "read"],
      ["db.query", "model", "read"],
    ]);
  });
});

describe("Python api-call — a TestClient handed to a test (real-repo FP)", () => {
  it("reads the verbs of a parameter annotated TestClient and of a local built by TestClient(app), a module's URL as a hole", async () => {
    const calls = await apiCallsOf(`from fastapi.testclient import TestClient
from tests.utils import api_routes


def test_create_club(api_client: TestClient, unique_user):
    response = api_client.post(api_routes.clubs_create_url, json={"name": "Rovers"})
    api_client.get(api_routes.clubs_slug("rovers"), headers=unique_user.token)
    api_client.delete("/api/clubs/rovers")


def test_standings():
    client = TestClient(app)
    client.get("/api/standings")
`);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual([
      "post ${api_routes.clubs_create_url}",
      "get null",
      "delete /api/clubs/rovers",
      "get /api/standings",
    ]);
  });
});

describe("Python raw SQL — an f-string's value in a table's place (real-repo FP)", () => {
  it("names no table `x` for `FROM {model.__tablename__}`, and keeps a literal table beside a value hole", async () => {
    const src = [
      "def duplicates(session, model):",
      "    session.execute(sa.text(f\"SELECT id, name FROM {model.__tablename__}\"))",
      "def club(session, club_id):",
      "    session.execute(sa.text(f\"SELECT name FROM clubs WHERE id = {club_id}\"))",
    ].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database" && d.name === "session.execute");
    expect(rows.map((d) => d.entity ?? null)).toEqual([null, "clubs"]);
  });
});
