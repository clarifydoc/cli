/**
 * A dependency-free Model Context Protocol server.
 *
 * MCP is JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout, so the whole
 * transport is a couple of hundred lines and needs no SDK — which matters here
 * because this module is bundled into the VS Code extension (see
 * VsCode/scripts/bundle-cli.mjs) and the analyzer keeps its dependency closure
 * deliberately small.
 *
 * Only the parts of the protocol this server uses are implemented: `initialize`,
 * `tools/list`, `tools/call`, `resources/list`, `resources/read` and `ping`.
 * Everything else answers with a well-formed "method not found".
 *
 * STDOUT IS THE WIRE. Nothing else may write to it while a server is serving —
 * `startMcpServer` redirects console output to stderr for exactly that reason.
 */

import { validateArguments } from "./validate.js";

/** Protocol revisions we can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * What a tool handler returns. `isError` marks a *tool* failure (the call
 * succeeded at the protocol level but the tool could not do its job) — the spec
 * wants those reported in the result, not as a JSON-RPC error, so the model can
 * read the message and react.
 */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  /** Human-readable name for UIs that show one (`annotations.title`). */
  title?: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Defaults to true; set false for tools that mutate state (running a scan). */
  readOnly?: boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string> | string;
}

/**
 * A parameterized resource (`clarifydoc://file/{path}`): `read` gets the
 * template's variables, decoded, or returns null when they name nothing.
 */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  read: (vars: Record<string, string>) => Promise<string | null> | string | null;
}

/** A workflow the user can pick in a client: a filled-in instruction for the model. */
export interface McpPrompt {
  name: string;
  title?: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  render: (args: Record<string, string>) => string;
}

export interface McpServerOptions {
  name: string;
  version: string;
  /** Shown to the model once, at connection time — how to use this server. */
  instructions?: string;
  tools: McpTool[];
  resources?: McpResource[];
  resourceTemplates?: McpResourceTemplate[];
  prompts?: McpPrompt[];
  /** Diagnostics sink. Never stdout. */
  log?: (message: string) => void;
  /** A line to end a tool's answer with (a freshness warning), or null for none. */
  annotate?: (tool: string) => Promise<string | null>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class McpServer {
  private readonly tools = new Map<string, McpTool>();
  private readonly resources = new Map<string, McpResource>();
  private readonly templates: McpResourceTemplate[];
  private readonly prompts = new Map<string, McpPrompt>();
  private readonly log: (message: string) => void;
  /** Set once the client's `initialize` has been answered. */
  private negotiatedVersion: string | null = null;

  constructor(private readonly options: McpServerOptions) {
    for (const tool of options.tools) this.tools.set(tool.name, tool);
    for (const resource of options.resources ?? []) this.resources.set(resource.uri, resource);
    this.templates = options.resourceTemplates ?? [];
    for (const prompt of options.prompts ?? []) this.prompts.set(prompt.name, prompt);
    this.log = options.log ?? (() => {});
  }

  /** Negotiated protocol revision (null until `initialize`). */
  get protocolVersion(): string | null {
    return this.negotiatedVersion;
  }

  /**
   * Handle one parsed message. Returns the response to write, or null for
   * notifications (which carry no id and get no reply).
   */
  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    const isNotification = message.id === undefined || message.id === null;
    const id = isNotification ? null : (message.id as string | number);

    if (typeof message.method !== "string") {
      // A response to something we sent (we send no requests) — ignore.
      if (message.result !== undefined || message.error !== undefined) return null;
      return isNotification ? null : rpcFailure(id, INVALID_REQUEST, "Missing method");
    }

    if (isNotification) {
      this.log(`notification: ${message.method}`);
      return null;
    }

    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      const rpc = e as RpcError;
      if (rpc?.rpcCode) return rpcFailure(id, rpc.rpcCode, rpc.message, rpc.data);
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`error handling ${message.method}: ${msg}`);
      return rpcFailure(id, INTERNAL_ERROR, msg);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: [...this.tools.values()].map(describeTool) };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return {
          resources: [...this.resources.values()].map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        };
      case "resources/templates/list":
        return {
          resourceTemplates: this.templates.map((t) => ({
            uriTemplate: t.uriTemplate,
            name: t.name,
            description: t.description,
            mimeType: t.mimeType,
          })),
        };
      case "resources/read":
        return this.readResource(params);
      case "prompts/list":
        return {
          prompts: [...this.prompts.values()].map((p) => ({
            name: p.name,
            ...(p.title ? { title: p.title } : {}),
            description: p.description,
            arguments: p.arguments,
          })),
        };
      case "prompts/get":
        return this.getPrompt(params);
      default:
        throw rpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    // Echo the client's revision when we speak it; otherwise offer our newest
    // and let the client decide whether to continue (per the spec).
    const version =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    this.negotiatedVersion = version;
    const client = params.clientInfo as { name?: string; version?: string } | undefined;
    this.log(
      `initialize from ${client?.name ?? "unknown client"} ${client?.version ?? ""}`.trim() +
        ` (protocol ${requested ?? "unspecified"} -> ${version})`,
    );
    return {
      protocolVersion: version,
      capabilities: {
        tools: { listChanged: false },
        ...(this.resources.size > 0 || this.templates.length > 0 ? { resources: { listChanged: false, subscribe: false } } : {}),
        ...(this.prompts.size > 0 ? { prompts: { listChanged: false } } : {}),
      },
      serverInfo: { name: this.options.name, version: this.options.version },
      ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw rpcError(INVALID_PARAMS, "tools/call requires a string `name`");
    const tool = this.tools.get(name);
    if (!tool) throw rpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};

    // Rejected in-band, like a handler error: the model reads the message and
    // retries with the right spelling, instead of getting unfiltered rows for a
    // filter it misspelt.
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length) {
      this.log(`tools/call ${name} rejected: ${problems.join(" ")}`);
      return { content: [{ type: "text", text: `Invalid arguments for ${name}:\n${problems.map((p) => `- ${p}`).join("\n")}` }], isError: true };
    }

    const started = Date.now();
    try {
      const result = await tool.handler(args);
      this.log(`tools/call ${name} -> ${result.text.length} chars in ${Date.now() - started}ms`);
      const note = this.options.annotate ? await this.options.annotate(name).catch(() => null) : null;
      return {
        content: [{ type: "text", text: note ? `${result.text}\n\n${note}` : result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (e) {
      // A thrown handler is still a *tool* error: report it in-band so the model
      // sees the message instead of an opaque transport failure.
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`tools/call ${name} failed: ${msg}`);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }

  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = params.uri;
    if (typeof uri !== "string") throw rpcError(INVALID_PARAMS, "resources/read requires a string `uri`");
    const resource = this.resources.get(uri);
    if (resource) {
      const text = await resource.read();
      return { contents: [{ uri, mimeType: resource.mimeType, text }] };
    }
    for (const t of this.templates) {
      const vars = matchUriTemplate(t.uriTemplate, uri);
      if (!vars) continue;
      const text = await t.read(vars);
      if (text === null) break;
      return { contents: [{ uri, mimeType: t.mimeType, text }] };
    }
    throw rpcError(INVALID_PARAMS, `Unknown resource: ${uri}`);
  }

  private getPrompt(params: Record<string, unknown>): unknown {
    const name = params.name;
    if (typeof name !== "string") throw rpcError(INVALID_PARAMS, "prompts/get requires a string `name`");
    const prompt = this.prompts.get(name);
    if (!prompt) throw rpcError(INVALID_PARAMS, `Unknown prompt: ${name}`);
    const raw = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) args[k] = v.trim();
    const missing = prompt.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
    if (missing.length) throw rpcError(INVALID_PARAMS, `Prompt ${name} needs: ${missing.join(", ")}`);
    return {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
    };
  }
}

/**
 * The variables of a level-1 URI template (`clarifydoc://file/{path}`) in
 * `uri`, or null when it does not match. The last variable takes the rest of
 * the URI, slashes included, so a project path needs no escaping.
 */
export function matchUriTemplate(template: string, uri: string): Record<string, string> | null {
  const names: string[] = [];
  const source = template.split(/(\{[^}]+\})/).map((part, i, all) => {
    const m = /^\{([^}]+)\}$/.exec(part);
    if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(m[1]!);
    return i === all.length - 2 && all[all.length - 1] === "" ? "(.+)" : "([^/]+)";
  }).join("");
  const match = new RegExp(`^${source}$`).exec(uri);
  if (!match) return null;
  const vars: Record<string, string> = {};
  names.forEach((n, i) => { vars[n] = decodeURIComponent(match[i + 1]!); });
  return vars;
}

function describeTool(tool: McpTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      ...(tool.title ? { title: tool.title } : {}),
      readOnlyHint: tool.readOnly !== false,
      openWorldHint: false,
    },
  };
}

interface RpcError extends Error {
  rpcCode?: number;
  data?: unknown;
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  const e = new Error(message) as RpcError;
  e.rpcCode = code;
  e.data = data;
  return e;
}

function rpcFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export interface StdioOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Low-level line writer, taking precedence over `output`. `startMcpServer`
   * passes one so it can keep a handle on the REAL stdout after diverting
   * `process.stdout.write` (the analyzer draws a progress line straight to the
   * descriptor, which would otherwise land in the middle of a frame).
   */
  writeLine?: (line: string) => void;
  /** Called when the input stream ends (the client disconnected). */
  onClose?: () => void;
}

/**
 * Serve a session over newline-delimited JSON. Messages are dispatched as they
 * arrive without waiting for the previous one to finish, so a slow tool call
 * (an analysis run) never blocks a `ping`; each response is written as a single
 * line, which keeps interleaving safe.
 */
export function serveStdio(server: McpServer, options: StdioOptions = {}): Promise<void> {
  // Annotated (not inferred): process.stdin's concrete type unions its `on`
  // overloads with the interface's, which TypeScript then refuses to call.
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output: NodeJS.WritableStream = options.output ?? process.stdout;

  return new Promise<void>((resolve) => {
    let buffer = "";
    const pending = new Set<Promise<void>>();

    const emit = options.writeLine ?? ((line: string) => void output.write(line));
    const write = (response: JsonRpcResponse) => {
      emit(JSON.stringify(response) + "\n");
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        return;
      }
      // JSON-RPC batches were dropped in MCP 2025-06-18 but cost nothing to accept.
      const messages = Array.isArray(parsed)
        ? (parsed as JsonRpcMessage[])
        : [parsed as JsonRpcMessage];
      for (const message of messages) {
        const task: Promise<void> = server
          .handleMessage(message)
          .then((response) => {
            if (response) write(response);
          })
          .finally(() => pending.delete(task));
        pending.add(task);
      }
    };

    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    input.on("end", () => {
      handleLine(buffer);
      buffer = "";
      void Promise.allSettled([...pending]).then(() => {
        options.onClose?.();
        resolve();
      });
    });
    input.on("error", () => {
      options.onClose?.();
      resolve();
    });
  });
}
