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
      ["import requests, httpx", 'requests.get("https://api.example.com/v1/items")', 'httpx.post(f"{BASE}/api/x")'].join("\n"),
    );
    expect(calls).toEqual([
      { name: "get", target: "https://api.example.com/v1/items", line: 2 },
      { name: "post", target: "{BASE}/api/x", line: 3 },
    ]);
  });

  it("keeps a call whose URL is a variable, without inventing a URL from its name", async () => {
    expect(await apiCallsOf("requests.get(url)")).toEqual([{ name: "get", target: null, line: 1 }]);
  });

  it("reads requests.request(METHOD, url) as that method", async () => {
    expect(await apiCallsOf('requests.request("DELETE", "/api/items/1")')).toEqual([
      { name: "delete", target: "/api/items/1", line: 1 },
    ]);
  });

  it("accepts a session or client receiver only with a URL-shaped argument", async () => {
    const calls = await apiCallsOf(['self.session.get("/api/users")', 'cache_client.get("users")'].join("\n"));
    expect(calls).toEqual([{ name: "get", target: "/api/users", line: 1 }]);
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
      "Order.objects.filter(paid=True)",
      "session.query(User).filter(User.id == 1).first()",
      "User.query.filter_by(name=n)",
      "db.users.find({})",
      "user.orders.all()",
      "order.save()",
    ].join("\n"))).toEqual([
      "cursor.execute",
      "self.conn.execute",
      "Order.objects.filter",
      "session.query(User).filter(User.id == 1).first",
      "session.query(User).filter",
      "session.query",
      "User.query.filter_by",
      "db.users.find",
      "user.orders.all",
      "order.save",
    ]);
  });

  it("names the model of a Django manager or a Flask-SQLAlchemy query, not the manager", async () => {
    const src = ["Order.objects.filter(paid=True).first()", "User.query.filter_by(name=n)", "orders.objects.all()"].join("\n");
    const tree = await parseSource(src, "python" as never, "x.py");
    const rows = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database").map((d) => `${d.name} → ${d.entity ?? "-"}`);
    expect(rows).toEqual(["Order.objects.filter(paid=True).first → Order", "Order.objects.filter → Order", "User.query.filter_by → User", "orders.objects.all → -"]);
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

describe("Python URLs and SQL held in locals", () => {
  const rows = async (src: string) => {
    const tree = await parseSource(src, "python" as never, "x.py");
    return new PythonDataSourceExtractor().extract(tree, src).map((d) => [d.kind, d.target, d.entity ?? null, d.access ?? null]);
  };

  it("reads an HTTP call's URL from a local assigned once", async () => {
    expect(await rows([
      "def sync(user_id):",
      '    url = f"{BASE}/users/{user_id}"',
      "    requests.get(url)",
      "    requests.post(BASE_URL + \"/users\")",
    ].join("\n"))).toEqual([["api-call", "{BASE}/users/{user_id}", null, null], ["api-call", "{}/users", null, null]]);
  });

  it("reads the table and the verb from raw SQL, literal or local", async () => {
    expect(await rows([
      "def report(cursor, n):",
      '    cursor.execute("SELECT id FROM orders WHERE total > %s", (n,))',
      '    sql = "UPDATE customers SET flagged = 1 WHERE id = %s"',
      "    cursor.execute(sql, (n,))",
      '    session.execute(text("DELETE FROM sessions WHERE expired"))',
    ].join("\n"))).toEqual([
      ["database", "orders", "orders", "read"],
      ["database", "customers", "customers", "write"],
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
    requests.post("/api/items", json={"name": name, "price": 9.5, "tags": ["a"], "active": True})
    requests.put("/api/items/1", json=payload)
`;
    const tree = await parseSource(src, "python" as never, "x.py");
    const calls = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.requestBody)).toEqual([
      { type: "object", properties: { name: {}, price: { type: "number" }, tags: { type: "array", items: { type: "string" } }, active: { type: "boolean" } } },
      { type: "object", properties: { title: { type: "string" }, count: { type: "integer" } }, additionalProperties: true },
    ]);
  });
});
