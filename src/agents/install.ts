import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { WORKFLOW_PROMPTS } from "../mcp/prompts.js";
import { AGENT_GUIDANCE } from "../mcp/guidance.js";
import { GIT_SAFE_CONFIG } from "../core/git-safe.js";

/**
 * Wiring ClarifyDoc into agent hosts from the command line: the MCP server
 * entry each client reads, Claude Code hooks, skills made from the MCP
 * workflow prompts, and the AGENTS.md section. Every write merges into what
 * is there — other servers, hooks and text are kept — and is idempotent;
 * `--print` shows the result instead of writing it.
 */
export const CLIENTS = ["claude-code", "cursor", "vscode", "windsurf", "gemini", "codex", "claude-desktop"] as const;
export type Client = (typeof CLIENTS)[number];

/** How this CLI is started: the global/npx binary when it runs as one, else node + this script. */
export function selfCommand(argv?: string): { command: string; args: string[] } {
  const argv1 = argv ?? process.argv[1] ?? "";
  const script = resolve(argv1);
  if (/[\\/]node_modules[\\/]|[\\/]bin[\\/]clarifydoc(?:\.cmd)?$/.test(script) || /(^|[\\/])clarifydoc(?:\.cmd)?$/.test(argv1)) {
    return { command: "clarifydoc", args: [] };
  }
  return { command: process.execPath, args: [script] };
}

interface Planned {
  file: string;
  content: string;
  /** File mode to set after writing (an executable hook). */
  mode?: number;
  /** Said after the file is written (or printed). */
  note?: string;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Where Claude Desktop reads its MCP servers on this platform. */
function claudeDesktopConfig(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/**
 * Just the ClarifyDoc entry for one client, in that client's format, and the
 * file it belongs in — to paste by hand (`mcp --print-config`). Nothing is
 * read or written.
 */
export function mcpSnippet(client: Client, root: string, self = selfCommand()): { file: string; snippet: string } {
  const server = { command: self.command, args: [...self.args, "mcp"] };
  const withRoot = { ...server, args: [...server.args, root] };
  switch (client) {
    case "claude-code":
      return { file: join(root, ".mcp.json"), snippet: pretty({ mcpServers: { clarifydoc: server } }) };
    case "cursor":
      return { file: join(root, ".cursor", "mcp.json"), snippet: pretty({ mcpServers: { clarifydoc: server } }) };
    case "gemini":
      return { file: join(root, ".gemini", "settings.json"), snippet: pretty({ mcpServers: { clarifydoc: server } }) };
    case "vscode":
      return { file: join(root, ".vscode", "mcp.json"), snippet: pretty({ servers: { clarifydoc: { type: "stdio", ...server } } }) };
    case "windsurf":
      return { file: join(homedir(), ".codeium", "windsurf", "mcp_config.json"), snippet: pretty({ mcpServers: { clarifydoc: withRoot } }) };
    case "claude-desktop":
      return { file: claudeDesktopConfig(), snippet: pretty({ mcpServers: { clarifydoc: withRoot } }) };
    case "codex":
      return { file: join(homedir(), ".codex", "config.toml"), snippet: `[mcp_servers.clarifydoc]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(withRoot.args)}\n` };
  }
}

/** The project a user-level entry serves: the last argument after `mcp`. */
function entryRoot(entry: unknown): string | undefined {
  const args = (entry as { args?: unknown })?.args;
  if (!Array.isArray(args)) return undefined;
  const i = args.lastIndexOf("mcp");
  return i >= 0 && i < args.length - 1 ? String(args[args.length - 1]) : undefined;
}

/**
 * The key a user-level config (one file for every project) gets this
 * project's entry under. `clarifydoc` unless it already serves another
 * project — re-pointing it would silently detach that one — in which case the
 * entry already serving this root, else `clarifydoc-<folder>`.
 */
export function userServerKey(servers: Record<string, unknown>, root: string): string {
  const same = (a: string | undefined) => a !== undefined && resolve(a) === resolve(root);
  const ours = Object.keys(servers).filter((k) => /^clarifydoc(?:-|$)/.test(k));
  const serving = ours.find((k) => same(entryRoot(servers[k])));
  if (serving) return serving;
  if (!("clarifydoc" in servers) || entryRoot(servers.clarifydoc) === undefined) return "clarifydoc";
  const base = `clarifydoc-${(root.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  let key = base;
  for (let n = 2; key in servers; n++) key = `${base}-${n}`;
  return key;
}

/** `[mcp_servers.<name>]` tables of a Codex config.toml, with their args. */
function codexServers(toml: string): Record<string, { args?: string[] }> {
  const out: Record<string, { args?: string[] }> = {};
  for (const m of toml.matchAll(/^\[mcp_servers\.([\w-]+)\]\n((?:(?!\[)[^\n]*\n?)*)/gm)) {
    const args = /^args\s*=\s*(\[.*\])\s*$/m.exec(m[2]!)?.[1];
    let parsed: string[] | undefined;
    try {
      parsed = args ? (JSON.parse(args) as string[]) : undefined;
    } catch {
      parsed = undefined;
    }
    out[m[1]!] = { args: parsed };
  }
  return out;
}

const keptNote = (key: string, servers: Record<string, unknown>) =>
  key === "clarifydoc" ? undefined : `kept the "clarifydoc" entry for ${entryRoot(servers.clarifydoc)}; this project is "${key}"`;

/** The MCP server entry for one client, merged into its config file. */
export function planMcpConfig(client: Client, root: string, self = selfCommand()): Planned {
  const server = { command: self.command, args: [...self.args, "mcp"] };
  switch (client) {
    case "claude-code":
    case "cursor":
    case "gemini": {
      const file = client === "claude-code" ? join(root, ".mcp.json") : client === "cursor" ? join(root, ".cursor", "mcp.json") : join(root, ".gemini", "settings.json");
      const json = readJson(file);
      const servers = { ...((json.mcpServers as Record<string, unknown>) ?? {}), clarifydoc: server };
      return { file, content: pretty({ ...json, mcpServers: servers }) };
    }
    case "vscode": {
      const file = join(root, ".vscode", "mcp.json");
      const json = readJson(file);
      const servers = { ...((json.servers as Record<string, unknown>) ?? {}), clarifydoc: { type: "stdio", ...server } };
      return { file, content: pretty({ ...json, servers }) };
    }
    case "windsurf": {
      const file = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
      const json = readJson(file);
      // A user-level file: the project is passed explicitly.
      const existing = (json.mcpServers as Record<string, unknown>) ?? {};
      const key = userServerKey(existing, root);
      const servers = { ...existing, [key]: { ...server, args: [...server.args, root] } };
      return { file, content: pretty({ ...json, mcpServers: servers }), note: keptNote(key, existing) };
    }
    case "claude-desktop": {
      const file = claudeDesktopConfig();
      const json = readJson(file);
      // A user-level file: the project is passed explicitly.
      const existing = (json.mcpServers as Record<string, unknown>) ?? {};
      const key = userServerKey(existing, root);
      const servers = { ...existing, [key]: { ...server, args: [...server.args, root] } };
      return { file, content: pretty({ ...json, mcpServers: servers }), note: keptNote(key, existing) };
    }
    case "codex": {
      const file = join(homedir(), ".codex", "config.toml");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      const tables = codexServers(existing);
      const key = userServerKey(tables, root);
      const block = `[mcp_servers.${key}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify([...server.args, root])}\n`;
      const table = new RegExp(`\\n?\\[mcp_servers\\.${key}\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, "g");
      const without = existing.replace(table, "\n").replace(/\n{3,}/g, "\n\n");
      return { file, content: `${without.trimEnd()}${without.trim() ? "\n\n" : ""}${block}`, note: keptNote(key, tables) };
    }
  }
}

/** Claude Code hooks in the project's `.claude/settings.json`: before searches, after edits, at session start. */
export function planClaudeHooks(root: string, self = selfCommand()): Planned {
  const file = join(root, ".claude", "settings.json");
  const json = readJson(file);
  const cmd = (event: string) => [self.command, ...self.args, "hook", event].map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(" ");
  const hooks = { ...((json.hooks as Record<string, unknown[]>) ?? {}) };
  const add = (hostEvent: string, matcher: string | undefined, event: string) => {
    const list = [...((hooks[hostEvent] as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>) ?? [])];
    const command = cmd(event);
    // Already wired (by this or an earlier install): keep it as it is.
    if (list.some((h) => h.hooks?.some((x) => x.command === command || (x.command ?? "").endsWith(` hook ${event}`)))) return;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 10 }] } as never);
    hooks[hostEvent] = list;
  };
  add("PreToolUse", "Grep|Glob", "pre-search");
  add("PostToolUse", "Edit|Write|MultiEdit", "post-edit");
  add("SessionStart", undefined, "session-start");
  return { file, content: pretty({ ...json, hooks }) };
}

const HOOK_START = "# clarifydoc:start";
const HOOK_END = "# clarifydoc:end";

/** The git events that move the working tree, and when each should refresh. */
const GIT_EVENTS: Array<{ name: string; when?: string }> = [
  { name: "post-commit" },
  { name: "post-merge" },
  // `$3` is 1 for a branch checkout, 0 for a file checkout.
  { name: "post-checkout", when: '[ "$3" = "1" ]' },
];

/** Where this repository's hooks live: `core.hooksPath` when set, else `.git/hooks` (worktrees included). */
export function gitHooksDir(root: string): string {
  const out = execFileSync("git", [...GIT_SAFE_CONFIG, "rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return resolve(root, out);
}

/**
 * Git hooks that refresh the analysis after a commit, a merge or a branch
 * checkout: an incremental analysis in the background, so git never waits
 * and a failure never fails git. Only this repository's hooks directory is
 * touched, never global config. The block sits between markers right after
 * the shebang, so a re-run replaces it and an existing hook keeps its own
 * lines; setting CLARIFYDOC_NO_GIT_HOOK skips it.
 */
export function planGitHooks(root: string, opts: { output?: string; hooksDir?: string } = {}, self = selfCommand()): Planned[] {
  const dir = opts.hooksDir ?? gitHooksDir(root);
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const run = [self.command, ...self.args].map(q).join(" ");
  return GIT_EVENTS.map(({ name, when }) => {
    const file = join(dir, name);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const refresh = `(cd ${q(root)} && ${run} analyze . -o ${q(opts.output ?? ".clarifydoc")} --incremental --no-lsp --no-pretty </dev/null >/dev/null 2>&1 &)`;
    const body = when ? `if ${when}; then\n  ${refresh}\nfi` : refresh;
    const block = `${HOOK_START}\n# Refresh the ClarifyDoc analysis in the background (clarifydoc install --git-hooks).\nif [ -z "$CLARIFYDOC_NO_GIT_HOOK" ]; then\n${body.split("\n").map((l) => `  ${l}`).join("\n")}\nfi\n${HOOK_END}\n`;
    const i = existing.indexOf(HOOK_START);
    const j = existing.indexOf(HOOK_END);
    let content: string;
    if (i >= 0 && j > i) content = `${existing.slice(0, i)}${block}${existing.slice(j + HOOK_END.length).replace(/^\n/, "")}`;
    else if (existing.startsWith("#!")) {
      const nl = existing.indexOf("\n");
      content = nl < 0 ? `${existing}\n${block}` : `${existing.slice(0, nl + 1)}${block}${existing.slice(nl + 1)}`;
    } else content = `#!/bin/sh\n${block}${existing}`;
    return { file, content, mode: 0o755 };
  });
}

/** One skill per MCP workflow prompt, under `.claude/skills/clarifydoc-<name>/SKILL.md`. */
export function planSkills(root: string): Planned[] {
  return WORKFLOW_PROMPTS.map((p) => {
    const placeholders = Object.fromEntries(p.arguments.map((a) => [a.name, `<${a.name}>`]));
    const args = p.arguments.length
      ? `\n\nArguments (fill them from the request): ${p.arguments.map((a) => `\`<${a.name}>\` — ${a.description}${a.required ? "" : " (optional; drop the steps that need it)"}`).join("; ")}.`
      : "";
    const body = `---\nname: clarifydoc-${p.name}\ndescription: ${JSON.stringify(p.description)}\n---\n\n# ${p.title ?? p.name}\n\nUses the \`clarifydoc\` MCP server.${args}\n\n${p.render(placeholders)}\n`;
    return { file: join(root, ".claude", "skills", `clarifydoc-${p.name}`, "SKILL.md"), content: body };
  });
}

const START = "<!-- clarifydoc:start -->";
const END = "<!-- clarifydoc:end -->";

/**
 * The ClarifyDoc section of AGENTS.md (or CLAUDE.md), between markers so a
 * re-run replaces only it: when to use the MCP server, plus what this
 * project's analysis says it should know first — its hub files and the gaps
 * the map found.
 */
export function planGuidance(root: string, file = "AGENTS.md", facts: string[] = []): Planned {
  const path = join(root, file);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const projectPart = facts.length ? `\n### In this project\n\n${facts.map((f) => `- ${f}`).join("\n")}\n` : "";
  const section = `${START}\n${AGENT_GUIDANCE.trimEnd()}\n${projectPart}${END}\n`;
  const i = existing.indexOf(START);
  const j = existing.indexOf(END);
  const content = i >= 0 && j > i
    ? `${existing.slice(0, i)}${section}${existing.slice(j + END.length).replace(/^\n/, "")}`
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${section}`;
  return { file: path, content };
}

/** Facts from an analysis worth an agent's first look: hubs, broken calls, contract findings, cycles. */
export function projectFacts(summary: {
  godNodes?: Array<{ file: string; degree: number }>;
  apiRouteLinkStats?: { unmatched?: number; refused?: { methodMismatch?: number } };
  contractFindings?: unknown[];
  layerViolations?: unknown[];
}): string[] {
  const out: string[] = [];
  const hubs = (summary.godNodes ?? []).slice(0, 5).map((g) => `\`${g.file}\``);
  if (hubs.length) out.push(`Hub files — a change there travels far, check \`clarifydoc_blast_radius\` first: ${hubs.join(", ")}.`);
  const missed = (summary.apiRouteLinkStats?.unmatched ?? 0) + (summary.apiRouteLinkStats?.refused?.methodMismatch ?? 0);
  if (missed) out.push(`${missed} API call(s) reach no route — \`clarifydoc_routes gaps=true\` lists them.`);
  if (summary.contractFindings?.length) out.push(`${summary.contractFindings.length} request body/route disagreement(s) — in \`clarifydoc_routes gaps=true\`.`);
  if (summary.layerViolations?.length) out.push(`${summary.layerViolations.length} import(s) break the layer order or a team rule — \`clarifydoc_health category="layers"\`.`);
  return out;
}

/** Write (or, with `print`, return) the planned files. */
export function applyPlans(plans: readonly Planned[], print: boolean): string[] {
  const out: string[] = [];
  for (const p of plans) {
    if (print) {
      out.push(`── ${p.file}\n${p.content}`);
      continue;
    }
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, p.content);
    if (p.mode !== undefined) chmodSync(p.file, p.mode);
    out.push(`wrote ${p.file}`);
    if (p.note) out.push(`  ${p.note}`);
  }
  return out;
}
