import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPathArgCalls } from "./path-arg-calls.js";

async function sitesOf(src: string) {
  const tree = await parseSource(src, "javascript" as never, "x.js");
  return extractPathArgCalls(tree, src);
}

describe("extractPathArgCalls", () => {
  it("records a call handing a path literal to a project function, every argument by position", async () => {
    expect(await sitesOf(`export const fetchStatus = createFetchHandler('system.status', '/system/status');`)).toEqual([
      { callee: "createFetchHandler", args: ["system.status", "/system/status"], line: 1 },
    ]);
  });

  it("records non-literal arguments as null and keeps member callees", async () => {
    expect(await sitesOf(`handlers.createRemoveItemHandler(section, '/tag');`)).toEqual([
      { callee: "createRemoveItemHandler", args: [null, "/tag"], line: 1 },
    ]);
  });

  it("skips HTTP clients themselves, module loads, and calls with no path argument", async () => {
    expect(await sitesOf(`fetch('/api/x'); axios.get('/api/y'); require('./lib/x'); log('hello', 'world');`)).toEqual([]);
  });
  it("records a template on a base constant as written, and the verb its options state", async () => {
    expect(await sitesOf(`await sendRequest(\`\${API_BASE_URL}/clubs/\${clubId}/squad\`, { method: "POST", body });
await sendRequest(\`\${API_BASE_URL}/clubs/all\`);`)).toEqual([
      { callee: "sendRequest", args: ["${API_BASE_URL}/clubs/${clubId}/squad", null], line: 1, method: "POST" },
      { callee: "sendRequest", args: ["${API_BASE_URL}/clubs/all"], line: 2 },
    ]);
  });
});
