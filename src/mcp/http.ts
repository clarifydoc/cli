import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readFileSync, statSync } from "node:fs";
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
  /** Idle time after which a session is forgotten (default `CLARIFYDOC_MCP_SESSION_TTL_MS`, else 30 minutes). */
  sessionTtlMs?: number;
  /** Most sessions kept; past it the least recently seen goes (default 64). */
  maxSessions?: number;
  /** Seconds-scale gap between keep-alive comments on an event stream (default 25 000 ms). */
  keepAliveMs?: number;
}

export interface HttpHandle {
  server: Server;
  url: string;
  /** Send a JSON-RPC notification down every open event stream. Returns how many streams got it. */
  broadcast(message: Record<string, unknown>): number;
  /** Live sessions (after dropping the expired). */
  sessionCount(): number;
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

export const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSIONS = 64;
/** Event streams one session may hold open; opening one more closes its oldest. */
export const MAX_STREAMS_PER_SESSION = 4;

interface Session {
  createdAt: number;
  lastSeen: number;
  client?: { name?: string; version?: string };
  streams: Set<ServerResponse>;
}

/**
 * Read a token from a file: its first line, trimmed. Throws when the file is
 * unreadable or empty; `warn` is told when others can read it (POSIX).
 */
export function readTokenFile(path: string, warn: (message: string) => void = () => {}): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read the token file ${path}: ${(e as Error).message}`);
  }
  const token = text.split(/\r?\n/)[0].trim();
  if (!token) throw new Error(`The token file ${path} is empty.`);
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      warn(`token file ${path} is readable by other users; restrict it (chmod 600)`);
    }
  } catch {
    /* the read above succeeded; a stat failure is not worth stopping for */
  }
  return token;
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
 * shares the one server — the analysis is loaded once. `GET /mcp` with
 * `Accept: text/event-stream` and a session id opens a server-sent event stream
 * the server pushes notifications down (`broadcast`); without that header it is
 * 405. A session lives until `DELETE`, idle expiry or eviction past the cap; an
 * unknown or expired id is 404, and the client initializes again.
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
  const ttl = options.sessionTtlMs ?? (Number(process.env.CLARIFYDOC_MCP_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS);
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const keepAliveMs = options.keepAliveMs ?? 25_000;
  const sessions = new Map<string, Session>();

  const endSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    for (const stream of s.streams) stream.end();
    s.streams.clear();
  };
  /** Drop sessions idle past the TTL; one with an open stream is not idle. */
  const sweep = (now = Date.now()): void => {
    for (const [id, s] of sessions) if (!s.streams.size && now - s.lastSeen > ttl) endSession(id);
  };
  const touch = (id: string): Session | undefined => {
    sweep();
    const s = sessions.get(id);
    if (s) {
      s.lastSeen = Date.now();
      // Keep the Map in least-recently-seen order.
      sessions.delete(id);
      sessions.set(id, s);
    }
    return s;
  };
  const create = (client: Session["client"]): string => {
    sweep();
    while (sessions.size >= maxSessions) endSession(sessions.keys().next().value as string);
    const id = randomUUID();
    const now = Date.now();
    sessions.set(id, { createdAt: now, lastSeen: now, client, streams: new Set() });
    return id;
  };
  const sweeper = setInterval(sweep, Math.min(60_000, Math.max(1000, ttl / 2)));
  sweeper.unref();
  const broadcast = (message: Record<string, unknown>): number => {
    const data = `data: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`;
    let n = 0;
    for (const s of sessions.values()) {
      for (const stream of s.streams) {
        stream.write(data);
        n++;
      }
    }
    return n;
  };

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
    const session = typeof sessionId === "string" ? touch(sessionId) : undefined;
    if (typeof sessionId === "string" && !session) {
      return send(res, 404, { error: "unknown or expired session" });
    }

    if (req.method === "DELETE") {
      if (typeof sessionId === "string") endSession(sessionId);
      return send(res, 200);
    }
    if (req.method === "GET") {
      if (!/text\/event-stream/i.test(req.headers.accept ?? "")) {
        return send(res, 405, { error: "method not allowed" }, { allow: "POST, DELETE, GET (event stream)" });
      }
      if (!session) return send(res, 400, { error: "an event stream needs an Mcp-Session-Id" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      while (session.streams.size >= MAX_STREAMS_PER_SESSION) {
        const oldest = session.streams.values().next().value as ServerResponse;
        session.streams.delete(oldest);
        oldest.end();
      }
      session.streams.add(res);
      const beat = setInterval(() => {
        session.lastSeen = Date.now();
        res.write(": keep-alive\n\n");
      }, keepAliveMs);
      beat.unref();
      res.on("close", () => {
        clearInterval(beat);
        session.streams.delete(res);
        session.lastSeen = Date.now();
      });
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST, DELETE, GET (event stream)" });

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
    const initialize = messages.find((m) => m.method === "initialize");
    if (initialize && !sessionId) {
      const info = (initialize.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined)?.clientInfo;
      headers["mcp-session-id"] = create(
        info ? { name: typeof info.name === "string" ? info.name : undefined, version: typeof info.version === "string" ? info.version : undefined } : undefined,
      );
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
    broadcast,
    sessionCount: () => (sweep(), sessions.size),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const id of [...sessions.keys()]) endSession(id);
        http.close(() => resolve());
        http.closeAllConnections?.();
      }),
  };
}
