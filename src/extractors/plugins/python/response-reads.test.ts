import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { PythonDataSourceExtractor } from "./data-sources.js";

async function readsOf(src: string): Promise<Array<[string | null, string[] | undefined]>> {
  const tree = await parseSource(src, "python" as any, "client.py");
  return new PythonDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => [d.target, d.responseReads]);
}

describe("Python response reads", () => {
  it("follows the body through the function's bindings", async () => {
    expect(await readsOf(`
import requests, httpx

def totals():
    return requests.get("/api/totals").json()["sum"]

def orders():
    resp = requests.get("/api/orders")
    items = resp.json()["items"]
    data = resp.json()
    return data["total"], data.get("next")

async def user(client: httpx.AsyncClient):
    r = await client.get("/api/me")
    body = r.json()
    return body["name"]

def raw():
    data = httpx.get("/api/raw").json()
    return data.get("count")

def passed_on():
    return requests.get("/api/x")
`)).toEqual([
      ["/api/totals", ["sum"]],
      ["/api/orders", ["items", "next", "total"]],
      ["/api/me", ["name"]],
      ["/api/raw", ["count"]],
      ["/api/x", undefined],
    ]);
  });
});
