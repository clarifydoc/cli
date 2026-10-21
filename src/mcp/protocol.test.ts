import { describe, it, expect } from "vitest";
import { PassThrough } from "stream";
import {
  LATEST_PROTOCOL_VERSION,
  McpServer,
  serveStdio,
  type JsonRpcResponse,
  type McpTool,
  matchUriTemplate,
} from "./protocol.js";

const echoTool: McpTool = {
  name: "echo",
  description: "echo back",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  handler: (args) => ({ text: `echo: ${String(args.text ?? "")}` }),
};

const boomTool: McpTool = {
  name: "boom",
  description: "always throws",
  inputSchema: { type: "object", properties: {} },
  readOnly: false,
  handler: () => {
    throw new Error("kaboom");
  },
};

function build(): McpServer {
  return new McpServer({
    name: "test",
    version: "9.9.9",
    instructions: "how to use me",
    tools: [echoTool, boomTool],
    resources: [
      {
        uri: "test://ball",
        name: "ball",
        description: "a ball",
        mimeType: "text/plain",
        read: () => "ball body",
      },
    ],
  });
}

const request = (server: McpServer, method: string, params?: Record<string, unknown>, id: number = 1) =>
  server.handleMessage({ jsonrpc: "2.0", id, method, params });

describe("McpServer — initialize", () => {
  it("echoes a protocol version it supports", async () => {
    const res = await request(build(), "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "vitest", version: "1" },
    });
    const result = res?.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo).toEqual({ name: "test", version: "9.9.9" });
  });

  it("falls back to its newest revision for an unknown one, and advertises capabilities", async () => {
    const res = await request(build(), "initialize", { protocolVersion: "1999-01-01" });
    const result = res?.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      instructions: string;
    };
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
    expect(result.instructions).toBe("how to use me");
  });

  it("omits the resources capability when no resources are registered", async () => {
    const server = new McpServer({ name: "t", version: "1", tools: [echoTool] });
    const res = await request(server, "initialize", {});
    expect((res?.result as { capabilities: Record<string, unknown> }).capabilities.resources).toBeUndefined();
  });
});

describe("McpServer — tools", () => {
  it("lists tools with schema and read-only annotations", async () => {
    const res = await request(build(), "tools/list");
    const tools = (res?.result as { tools: Array<Record<string, any>> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(tools[0].inputSchema.type).toBe("object");
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[1].annotations.readOnlyHint).toBe(false);
  });

  it("calls a tool and returns text content", async () => {
    const res = await request(build(), "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(res?.result).toEqual({ content: [{ type: "text", text: "echo: hi" }] });
  });

  it("reports a thrown handler as a tool error, not a transport error", async () => {
    const res = await request(build(), "tools/call", { name: "boom" });
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(res?.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });

  it("rejects an unknown tool and a missing name with invalid-params", async () => {
    expect((await request(build(), "tools/call", { name: "nope" }))?.error?.code).toBe(-32602);
    expect((await request(build(), "tools/call", {}))?.error?.code).toBe(-32602);
  });
});

describe("McpServer — resources and dispatch", () => {
  it("lists and reads a resource", async () => {
    const list = await request(build(), "resources/list");
    expect((list?.result as { resources: Array<{ uri: string }> }).resources[0].uri).toBe("test://ball");
    const read = await request(build(), "resources/read", { uri: "test://ball" });
    expect(read?.result).toEqual({
      contents: [{ uri: "test://ball", mimeType: "text/plain", text: "ball body" }],
    });
  });

  it("answers unknown resources and methods with the right codes", async () => {
    expect((await request(build(), "resources/read", { uri: "test://missing" }))?.error?.code).toBe(-32602);
    expect((await request(build(), "sampling/createMessage"))?.error?.code).toBe(-32601);
  });

  it("never replies to a notification", async () => {
    const server = build();
    expect(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handleMessage({ jsonrpc: "2.0", id: null, method: "ping" })).toBeNull();
    // A response to something we never sent is ignored too.
    expect(await server.handleMessage({ jsonrpc: "2.0", result: {} })).toBeNull();
  });

  it("answers ping", async () => {
    expect((await request(build(), "ping"))?.result).toEqual({});
  });
});

describe("serveStdio", () => {
  /** Drive a session over paired streams and collect the parsed replies. */
  async function session(lines: string[]): Promise<JsonRpcResponse[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
    const done = serveStdio(build(), { input, output });
    for (const line of lines) input.write(line);
    input.end();
    await done;
    return chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JsonRpcResponse);
  }

  it("handles newline-delimited requests, including a message split across chunks", async () => {
    const responses = await session([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"too',
      'ls/list"}\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"x"}}}',
    ]);
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(responses[2].result).toEqual({ content: [{ type: "text", text: "echo: x" }] });
  });

  it("reports malformed JSON as a parse error without dropping the session", async () => {
    const responses = await session(['not json\n', '{"jsonrpc":"2.0","id":7,"method":"ping"}\n']);
    expect(responses[0].error?.code).toBe(-32700);
    expect(responses[1].id).toBe(7);
  });
});

describe("McpServer — prompts and resource templates", () => {
  const server = () => new McpServer({
    name: "t",
    version: "1",
    tools: [],
    resourceTemplates: [{
      uriTemplate: "test://file/{path}",
      name: "file",
      description: "a file",
      mimeType: "text/plain",
      read: ({ path }) => (path === "nope" ? null : `file ${path}`),
    }],
    prompts: [{
      name: "review",
      description: "review a file",
      arguments: [{ name: "file", description: "which", required: true }],
      render: ({ file }) => `Review ${file}`,
    }],
  });

  it("lists and fills a prompt, and names a missing argument", async () => {
    const list = await request(server(), "prompts/list");
    expect((list?.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name)).toEqual(["review"]);
    const got = await request(server(), "prompts/get", { name: "review", arguments: { file: "src/a.ts" } });
    expect(got?.result).toEqual({
      description: "review a file",
      messages: [{ role: "user", content: { type: "text", text: "Review src/a.ts" } }],
    });
    const missing = await request(server(), "prompts/get", { name: "review", arguments: {} });
    expect(missing?.error?.message).toContain("needs: file");
  });

  it("reads a template resource, its last variable taking the rest of the URI", async () => {
    const read = await request(server(), "resources/read", { uri: "test://file/src/a%20b.ts" });
    expect(read?.result).toEqual({ contents: [{ uri: "test://file/src/a%20b.ts", mimeType: "text/plain", text: "file src/a b.ts" }] });
    expect((await request(server(), "resources/read", { uri: "test://file/nope" }))?.error?.code).toBe(-32602);
    expect(matchUriTemplate("x://symbol/{symbol}/{path}", "x://symbol/Repo.save/src/repo.ts")).toEqual({ symbol: "Repo.save", path: "src/repo.ts" });
    expect(matchUriTemplate("x://file/{path}", "x://other/a")).toBeNull();
  });

  it("advertises prompts in the capabilities", async () => {
    const init = await request(server(), "initialize", { protocolVersion: LATEST_PROTOCOL_VERSION });
    expect((init?.result as { capabilities: Record<string, unknown> }).capabilities).toMatchObject({ prompts: { listChanged: false }, resources: {} });
  });
});
