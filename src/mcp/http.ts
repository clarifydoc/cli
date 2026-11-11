import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PARSE_ERROR, INVALID_REQUEST, type JsonRpcMessage, type JsonRpcResponse, type McpServer } from "./protocol.js";

/** Most a request body may be; a tool call is a few hundred bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Bearer token. Required to bind anything but loopback. */
  token?: string;
  log?: (message: string) => void;
  maxBodyBytes?: number;
}

export interface HttpHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_NAMES.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith(".localhost");
}

/** The hostname of a `Host` header or an `Origin` URL, without port. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new TooLarge());
        // Keep draining (discarding) so the 413 can still be written.
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

const rpcError = (code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: null,
  error: { code, message },
});

/**
 * Serve one MCP server to several local agents over Streamable HTTP (the
 * request/response subset): `POST /mcp` carries a JSON-RPC message or batch and
 * is answered with JSON, or 202 when it holds only notifications. Every request
 * shares the one server — the analysis is loaded once. No server-initiated
 * stream is offered, so `GET /mcp` is 405.
 *
 * Loopback by default. Binding any other host needs a token, checked as
 * `Authorization: Bearer <token>`; on loopback `Host` and `Origin` must name
 * loopback too, so a web page cannot reach the server through DNS rebinding.
 */
export async function serveHttp(server: McpServer, options: HttpOptions = {}): Promise<HttpHandle> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token || undefined;
  const log = options.log ?? (() => {});
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const loopbackOnly = isLoopbackHost(host);
  if (!loopbackOnly && !token) {
    throw new Error(`Refusing to listen on ${host} without a token: set CLARIFYDOC_MCP_TOKEN (or pass --token, which shows in the process list).`);
  }
  const sessions = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return send(res, 404, { error: "not found" });

    if (loopbackOnly) {
      const h = req.headers.host ? hostnameOf(req.headers.host, false) : null;
      if (h === null || !isLoopbackHost(h)) return send(res, 403, { error: "forbidden host" });
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const o = hostnameOf(origin, true);
        if (o === null || !isLoopbackHost(o)) return send(res, 403, { error: "forbidden origin" });
      }
    }
    if (token) {
      const auth = req.headers.authorization ?? "";
      const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
      if (!tokenMatches(given, token)) {
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && !sessions.has(sessionId)) {
      return send(res, 404, { error: "unknown session" });
    }

    if (req.method === "DELETE") {
      if (typeof sessionId === "string") sessions.delete(sessionId);
      return send(res, 200);
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST, DELETE" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, limit));
    } catch (e) {
      if (e instanceof TooLarge) return send(res, 413, { error: "request body too large" }, { connection: "close" });
      return send(res, 400, rpcError(PARSE_ERROR, "Parse error"));
    }
    const batch = Array.isArray(parsed);
    const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[];
    if (!messages.length || messages.some((m) => typeof m !== "object" || m === null)) {
      return send(res, 400, rpcError(INVALID_REQUEST, "Invalid Request"));
    }

    const responses = (await Promise.all(messages.map((m) => server.handleMessage(m)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    if (!responses.length) return send(res, 202);

    const headers: Record<string, string> = {};
    if (messages.some((m) => m.method === "initialize") && !sessionId) {
      const id = randomUUID();
      sessions.add(id);
      headers["mcp-session-id"] = id;
    }
    send(res, 200, batch ? responses : responses[0], headers);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const addr = http.address() as AddressInfo;
  const shown = addr.address.includes(":") ? `[${addr.address}]` : addr.address;
  return {
    server: http,
    url: `http://${shown}:${addr.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections?.();
      }),
  };
}
