import { buildMcpServer, type McpServerConfig } from "./server.js";

/**
 * One MCP tool call from a shell or a CI step (`clarifydoc ask`): the same
 * server an agent talks to, with no transport — the call goes through
 * `tools/call`, so argument validation, the freshness banner and every tool's
 * caps are exactly what an agent would get. Read-only unless the caller
 * allows an analysis.
 */

export interface AskResult {
  text: string;
  isError: boolean;
}

/** `routes` → `clarifydoc_routes`; a full name stays as written. */
export function toolNameOf(name: string): string {
  return name.startsWith("clarifydoc_") ? name : `clarifydoc_${name.replace(/-/g, "_")}`;
}

export async function askTool(config: McpServerConfig, name: string, args: Record<string, unknown>): Promise<AskResult> {
  const { server, tools } = buildMcpServer(config);
  const tool = toolNameOf(name);
  if (!tools.some((t) => t.name === tool)) {
    return { text: `No tool ${tool}. Tools: ${tools.map((t) => t.name.replace(/^clarifydoc_/, "")).join(", ")}`, isError: true };
  }
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  if (!res) return { text: "No answer", isError: true };
  if ("error" in res && res.error) return { text: res.error.message, isError: true };
  const result = (res as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } }).result;
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return { text, isError: result?.isError === true };
}

/**
 * `ask explain --from-issue`: what an issue names that the analysis knows
 * (`issueSubjects`), and the explain pack of the likeliest — the budget split
 * among the first `explain` of them — after a list of every subject found and
 * why, so a reader sees what the issue was read as.
 */
export async function askFromIssue(config: McpServerConfig, issue: string, opts: { explain?: number; maxTokens?: number } = {}): Promise<AskResult> {
  const { issueSubjects } = await import("./issue-subjects.js");
  const { store } = buildMcpServer(config);
  const { summary } = await store.load();
  const subjects = issueSubjects(issue, summary);
  if (!subjects.length) {
    return { text: "# Nothing in the issue names a route, file or function the analysis knows\n\nNext: clarifydoc ask search query=<a term from the issue>", isError: false };
  }
  const explain = subjects.slice(0, Math.max(1, opts.explain ?? 2));
  const each = Math.floor((opts.maxTokens ?? 6000) / explain.length);
  const out = [
    `# From the issue: ${subjects.length} subject${subjects.length === 1 ? "" : "s"}`,
    "",
    ...subjects.map((s, i) => `${i + 1}. ${s.kind} ${s.subject}${s.file ? ` (${s.file})` : ""} — ${s.why}`),
  ];
  for (const s of explain) {
    const r = await askTool(config, "explain", { subject: s.subject, kind: s.kind, ...(s.file ? { file: s.file } : {}), maxTokens: Math.max(500, each) });
    out.push("", r.text.replace(/^# /, "## ").replace(/\n## /g, "\n### "));
  }
  return { text: out.join("\n"), isError: false };
}

/** Each tool's name, description and arguments, for `ask --list`. */
export function listTools(config: McpServerConfig): Array<{ name: string; description: string; args: string[] }> {
  return buildMcpServer(config).tools.map((t) => {
    const props = (t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
    const required = new Set((t.inputSchema as { required?: string[] }).required ?? []);
    return { name: t.name, description: t.description, args: Object.keys(props).map((k) => (required.has(k) ? k : `${k}?`)) };
  });
}

/**
 * The arguments: a JSON object (`--args '{"path":"/api"}'`), plus `key=value`
 * pairs where a value that reads as JSON (a number, true, an array) is taken
 * as such, else as a string.
 */
export function parseAskArgs(json: string | undefined, pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`--args is not JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--args must be a JSON object");
    Object.assign(out, parsed);
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    if (/^(?:-?\d+(?:\.\d+)?|true|false|null|\[.*\]|\{.*\})$/s.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out[key] = value;
  }
  return out;
}
