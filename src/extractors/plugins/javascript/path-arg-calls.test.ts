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
});
