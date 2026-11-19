import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonDataSourceExtractor } from "./data-sources.js";
import { extractPythonHttpClientRegistrations } from "./http-clients.js";

async function read(src: string) {
  const tree = await parseSource(src, "python" as never, "x.py");
  const calls = new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
  return { regs: extractPythonHttpClientRegistrations(tree, src), calls: calls.map((c) => [c.target, c.client ?? null]) };
}

describe("Python HTTP clients with a stated base", () => {
  it("keys an httpx client by the name it is held in and names it on the request", async () => {
    const { regs, calls } = await read([
      "import httpx",
      "client = httpx.Client(base_url=\"http://league-api:8080\")",
      "other = httpx.Client(base_url=\"http://cars-api:8080\")",
      "class Repo:",
      "    def __init__(self):",
      "        self.http = httpx.AsyncClient(base_url=\"http://league-api:8080\")",
      "    def players(self):",
      "        return self.http.get(\"/players\")",
      "def clubs():",
      "    client.get(\"/clubs\")",
      "    other.get(\"/cars\")",
    ].join("\n"));
    expect(regs.map((r) => [r.client, r.base])).toEqual([
      ["client", { kind: "literal", key: "http://league-api:8080" }],
      ["other", { kind: "literal", key: "http://cars-api:8080" }],
      ["self.http", { kind: "literal", key: "http://league-api:8080" }],
    ]);
    expect(calls).toEqual([["/players", "self.http"], ["/clubs", "client"], ["/cars", "other"]]);
  });

  it("reads an environment base, with its fallback, and a `with … as` client", async () => {
    const { regs } = await read([
      "import os, httpx, aiohttp",
      "a = httpx.Client(base_url=os.environ[\"LEAGUE_URL\"])",
      "b = httpx.Client(base_url=os.getenv(\"CLUB_URL\", \"http://club-api:80\"))",
      "c = httpx.Client(base_url=os.environ.get(\"CAR_URL\") or \"http://car-api\")",
      "async def run():",
      "    async with aiohttp.ClientSession(base_url=\"http://player-api:9\") as s:",
      "        await s.get(\"/players\")",
    ].join("\n"));
    expect(regs.map((r) => [r.client, r.base])).toEqual([
      ["a", { kind: "env", key: "LEAGUE_URL" }],
      ["b", { kind: "env", key: "CLUB_URL", fallback: "http://club-api:80" }],
      ["c", { kind: "env", key: "CAR_URL", fallback: "http://car-api" }],
      ["s", { kind: "literal", key: "http://player-api:9" }],
    ]);
  });

  it("registers nothing for a session without a base, a path-only base, a computed one or a namesake Client", async () => {
    const { regs, calls } = await read([
      "import requests, httpx",
      "from mylib import Client",
      "s = requests.Session()",
      "p = httpx.Client(base_url=\"/api\")",
      "q = httpx.Client(base_url=build())",
      "d = Client(base_url=\"http://decoy:1\")",
      "s.get(\"/clubs\")",
    ].join("\n"));
    expect(regs).toEqual([]);
    expect(calls.every(([, client]) => client === null)).toBe(true);
  });
});

describe("Python client names bound more than once", () => {
  it("registers neither when another function binds the name to something else", async () => {
    const { regs, calls } = await read([
      "import httpx, requests",
      "def a():",
      "    client = httpx.Client(base_url=\"http://league-api:8080\")",
      "    client.get(\"/clubs\")",
      "def b():",
      "    client = requests.Session()",
      "    client.get(\"/clubs\")",
    ].join("\n"));
    expect(regs).toEqual([]);
    expect(calls.every(([, c]) => c === null)).toBe(true);
  });
});
