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
      { name: "requests.get", target: "https://api.example.com/v1/items", line: 2 },
      { name: "httpx.post", target: "{BASE}/api/x", line: 3 },
    ]);
  });

  it("keeps a call whose URL is a variable, without inventing a URL from its name", async () => {
    expect(await apiCallsOf("requests.get(url)")).toEqual([{ name: "requests.get", target: null, line: 1 }]);
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
    expect(calls).toEqual([{ name: "requests.get", target: "/api/x", line: 1 }]);
  });
});
