import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "stream";
import { McpServer, FrameReader, serveStdio, type McpTool } from "./protocol.js";
import { serveHttp, type HttpHandle } from "./http.js";

const tool: McpTool = {
  name: "kickoff",
  description: "start the match",
  inputSchema: { type: "object", properties: { club: { type: "string" } } },
  handler: (args) => ({ text: `${String(args.club ?? "nobody")} kicks off` }),
};
const build = () => new McpServer({ name: "league", version: "1.0.0", tools: [tool] });

const frame = (msg: unknown) => {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } } };

describe("FrameReader", () => {
  it("reads framed messages split at every byte, with multi-byte text", () => {
    const wire = Buffer.from(frame({ a: "Müller ⚽" }) + frame({ b: 2 }), "utf8");
    const reader = new FrameReader();
    const out: string[] = [];
    for (const byte of wire) for (const f of reader.push(Buffer.from([byte]))) out.push(f.text);
    expect(out.map((t) => JSON.parse(t))).toEqual([{ a: "Müller ⚽" }, { b: 2 }]);
  });

  it("reads newline-delimited and mixed framing, per message", () => {
    const reader = new FrameReader();
    const frames = [...reader.push('{"a":1}\n' + frame({ b: 2 }) + '{"c":3}\r\n'), ...reader.end()];
    expect(frames.map((f) => f.framed)).toEqual([false, true, false]);
    expect(frames.map((f) => JSON.parse(f.text))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("handles a large body arriving in chunks", () => {
    const big = { text: "x".repeat(300_000) };
    const wire = Buffer.from(frame(big));
    const reader = new FrameReader();
    const out = [];
    for (let i = 0; i < wire.length; i += 7000) out.push(...reader.push(wire.subarray(i, i + 7000)));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].text)).toEqual(big);
  });
});

describe("serveStdio framing", () => {
  const run = async (input: string[]) => {
    const inp = new PassThrough();
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c) => chunks.push(c));
    const done = serveStdio(build(), { input: inp, output: out });
    for (const piece of input) inp.write(piece);
    inp.end();
    await done;
    return Buffer.concat(chunks).toString("utf8");
  };

  it("answers framed requests in Content-Length framing", async () => {
    const wire = frame(init) + frame({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const half = Math.floor(wire.length / 2);
    const text = await run([wire.slice(0, half), wire.slice(half)]);
    const reader = new FrameReader();
    const frames = reader.push(text);
    expect(frames.every((f) => f.framed)).toBe(true);
    const bodies = frames.map((f) => JSON.parse(f.text));
    expect(bodies.map((b) => b.id).sort()).toEqual([1, 2]);
    expect(bodies.find((b) => b.id === 2).result.tools[0].name).toBe("kickoff");
  });

  it("still answers newline-delimited requests on one line", async () => {
    const text = await run([JSON.stringify(init) + "\n"]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith("Content-Length")).toBe(false);
    expect(JSON.parse(text).id).toBe(1);
  });
});

describe("serveHttp", () => {
  let handle: HttpHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(handle!.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers initialize with a session id, then calls, notifications and batches", async () => {
    handle = await serveHttp(build(), { port: 0 });
    const res = await post(init);
    expect(res.status).toBe(200);
    const session = res.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    expect(((await res.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("league");

    const headers = { "mcp-session-id": session };
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
    const calls = await Promise.all(
      ["Arsenal", "Chelsea"].map((club, i) =>
        post({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "kickoff", arguments: { club } } }, headers).then((r) => r.json()),
      ),
    );
    expect(JSON.stringify(calls[0])).toContain("Arsenal kicks off");
    expect(JSON.stringify(calls[1])).toContain("Chelsea kicks off");
    const batch = (await (await post([{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "ping" }], headers)).json()) as unknown[];
    expect(batch).toHaveLength(2);

    expect((await post(init, { "mcp-session-id": "nope" })).status).toBe(404);
    expect((await fetch(handle.url)).status).toBe(405);
  });

  it("refuses a foreign Origin and Host, bad JSON and oversized bodies", async () => {
    handle = await serveHttp(build(), { port: 0, maxBodyBytes: 1000 });
    expect((await post(init, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(init, { origin: "http://localhost:5173" })).status).toBe(200);
    expect((await post(init, { origin: "http://127.0.0.1.evil.example" })).status).toBe(403);
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ pad: "x".repeat(5000) })).status).toBe(413);
  });

  it("requires a token off loopback and checks the bearer on request", async () => {
    await expect(serveHttp(build(), { host: "0.0.0.0", port: 0 })).rejects.toThrow(/token/);
    handle = await serveHttp(build(), { host: "0.0.0.0", port: 0, token: "secret" });
    const url = handle.url.replace("0.0.0.0", "127.0.0.1");
    const send = (auth?: string) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(init) });
    expect((await send()).status).toBe(401);
    expect((await send("Bearer wrong")).status).toBe(401);
    expect((await send("Bearer secret")).status).toBe(200);
  });
});
