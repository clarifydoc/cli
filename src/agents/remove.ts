import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { removeJsoncMember, parseJsonc } from "./jsonc.js";
import { HOOK_EVENTS } from "./hooks.js";
import {
  CLIENTS,
  CODEX_HOOK_END,
  CODEX_HOOK_START,
  GUIDANCE_END,
  GUIDANCE_START,
  HOOK_END,
  HOOK_START,
  codexServers,
  damagedNote,
  entryRoot,
  findMarkedRegion,
  gitHooksDir,
  isRecord,
  mcpSnippet,
  planClaudeHooks,
  planCodexHooks,
  planCopilotHooks,
  planGitHooks,
  planPlugin,
  planSkills,
  pretty,
  readJson,
  selfCommand,
  type Client,
} from "./install.js";

/**
 * The undo of `install`: ClarifyDoc's entries taken out of every file install
 * merges into, the files it wrote whole deleted. The files are the very ones
 * install's own plan functions name, and each file is edited surgically — only
 * the marked block, the one JSON member or the hook entries of ours go, so
 * what a person wrote stays byte for byte. Unbalanced markers are refused, as
 * install refuses them. A file that holds nothing once ours is gone is
 * deleted (install created it, or nothing else is worth keeping); an empty
 * directory it leaves is removed too.
 */
export interface RemovalAction {
  file: string;
  /** Delete the file. */
  remove?: boolean;
  /** The new text of an edited file. */
  content?: string;
  /** Why the file is left as it is. */
  skip?: string;
  /** Keep the (now empty) directory: it is not ours. */
  keepDir?: boolean;
  /** Empty directories are removed upward to here as well. */
  stop?: string;
}

export interface RemovalReport {
  removed: string[];
  edited: string[];
  skipped: Array<{ file: string; reason: string }>;
  errors: Array<{ file: string; error: string }>;
}

export interface RemovalOptions {
  root: string;
  /** Clients whose MCP entries and hooks go; default every client. */
  clients?: readonly Client[];
  mcp?: boolean;
  hooks?: boolean;
  skills?: boolean;
  gitHooks?: boolean;
  /** AGENTS.md / CLAUDE.md, or the file named. */
  guidance?: boolean | string;
  /** A plugin directory (`install --plugin`). */
  plugin?: { dir: string; tools: ReadonlyArray<{ name: string; readOnly?: boolean }> };
  codexDir?: string;
  copilotDir?: string;
}

/** What the earlier actions of this removal already did to a file, so two of them on one file build on each other. */
let overlay = new Map<string, string | null>();

const read = (file: string): string | undefined => {
  const seen = overlay.get(file);
  if (seen !== undefined) return seen === null ? undefined : seen;
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** Text that is left of a file once ours is cut out: nothing → delete the file. */
const tidyText = (text: string): string => (text.trim() ? `${text.trimEnd()}\n` : "");

function edit(file: string, text: string, next: string, emptyIf?: (next: string) => boolean): RemovalAction | undefined {
  if (next === text) return undefined;
  if (next.trim() === "" || emptyIf?.(next)) return { file, remove: true };
  return { file, content: next };
}

/** Cut `[start, end)` and the newline after it; what is left is joined with one blank line as install joined it. */
function cutBlock(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^\n/, "");
  return after.trim() ? `${before}${after}` : tidyText(before);
}

/** A marked block taken out of a text file. */
function removeMarked(file: string, start: string, end: string, tail = "", emptyIf?: (next: string) => boolean): RemovalAction | undefined {
  const text = read(file);
  if (text === undefined) return undefined;
  const region = findMarkedRegion(text, start, end);
  if (region.kind === "none") return undefined;
  if (region.kind === "damaged") return { file, skip: damagedNote(region.reason).replace(/run install again/, "run the removal again") };
  return edit(file, text, cutBlock(text, region.start, region.end + end.length + tail.length), emptyIf);
}

/** Whether a hook command is one `install` wrote: it names ClarifyDoc and ends with `hook <event>`. */
const isOurHookCommand = (command: unknown): boolean => {
  if (typeof command !== "string" || !HOOK_EVENTS.some((e) => command.endsWith(` hook ${e}`))) return false;
  // The launcher names ClarifyDoc, or is the one this process was started as (a checkout run as `node …/cli.js`).
  return /clarifydoc/.test(command) || selfCommand().args.some((w) => w !== "" && command.includes(w));
};

/** The hooks object of a Claude-format JSON without our commands; the entry kept when a person's hook shares it. */
function withoutOurHooks(json: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(json.hooks)) return undefined;
  let changed = false;
  const hooks: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(json.hooks)) {
    if (!Array.isArray(list)) {
      hooks[event] = list;
      continue;
    }
    const kept: unknown[] = [];
    for (const entry of list) {
      const inner = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : undefined;
      if (!inner || !inner.some((h) => isRecord(h) && isOurHookCommand(h.command))) {
        kept.push(entry);
        continue;
      }
      changed = true;
      const rest = inner.filter((h) => !(isRecord(h) && isOurHookCommand(h.command)));
      if (rest.length) kept.push({ ...(entry as Record<string, unknown>), hooks: rest });
    }
    if (kept.length) hooks[event] = kept;
  }
  if (!changed) return undefined;
  // The key keeps its place among the person's own.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    if (k !== "hooks") out[k] = v;
    else if (Object.keys(hooks).length) out[k] = hooks;
  }
  return out;
}

/** A Claude-format hooks file (`.claude/settings.json`, Codex's `hooks.json`) without our hook commands. */
function removeJsonHooks(file: string): RemovalAction | undefined {
  const text = read(file);
  if (text === undefined || !text.includes(" hook ")) return undefined;
  const json = readJson(file);
  if (json === null) return { file, skip: "it is not plain JSON (comments?), so it was not rewritten — remove the ClarifyDoc hook entries by hand" };
  const next = withoutOurHooks(json);
  if (!next) return undefined;
  return Object.keys(next).length === 0 ? { file, remove: true } : { file, content: pretty(next) };
}

/** Whether an MCP entry is the server `install` writes: its command line has the `mcp` subcommand (user-level files: `mcp <root>`, naming this project). */
function ourEntry(entry: unknown, root: string, userLevel: boolean): boolean {
  if (!isRecord(entry)) return false;
  const words = Array.isArray(entry.command) ? (entry.command as unknown[]) : Array.isArray(entry.args) ? (entry.args as unknown[]) : [];
  if (userLevel) {
    const at = entryRoot({ args: words });
    return at !== undefined && resolve(at) === resolve(root);
  }
  return words.includes("mcp");
}

/** One client's MCP entry out of its config file. */
function removeMcpEntry(client: Client, root: string): RemovalAction | undefined {
  const { file, snippet } = mcpSnippet(client, root);
  const text = read(file);
  if (text === undefined) return undefined;
  if (client === "codex") {
    const tables = codexServers(text);
    const keys = Object.keys(tables).filter((k) => /^clarifydoc(?:-|$)/.test(k) && ourEntry(tables[k], root, true));
    let next = text;
    for (const key of keys) next = next.replace(new RegExp(`\\n?\\[mcp_servers\\.${key}\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, "g"), "\n").replace(/\n{3,}/g, "\n\n");
    return edit(file, text, next === text ? text : tidyText(next));
  }
  const doc = parseJsonc(text);
  if (doc === undefined) return text.trim() && /clarifydoc/.test(text) ? { file, skip: "it is not JSON, so it was not rewritten — remove the clarifydoc entry by hand" } : undefined;
  const shape = JSON.parse(snippet) as object;
  const top = Object.keys(shape).find((k) => k !== "$schema")!;
  const entries = isRecord(doc) ? doc[top] : undefined;
  if (!isRecord(entries)) return undefined;
  // A user-level file names the project in the entry's arguments; a project file does not.
  const userLevel = JSON.stringify(shape).includes(JSON.stringify(root));
  const keys = Object.keys(entries).filter((k) => (userLevel ? /^clarifydoc(?:-|$)/.test(k) : k === "clarifydoc") && ourEntry(entries[k], root, userLevel));
  if (!keys.length) return undefined;
  let next: string | null = text;
  for (const key of keys) {
    next = next === null ? null : removeJsoncMember(next, top, key);
  }
  if (next === null) return { file, skip: "it could not be edited safely — remove the clarifydoc entry by hand" };
  // A config left holding nothing (or only OpenCode's schema line, which install adds) is one install made.
  const left = parseJsonc(next);
  const empty = isRecord(left) && Object.keys(left).every((k) => k === "$schema") && !/\/[/*]/.test(next);
  return edit(file, text, next, () => empty);
}

/** `~/.codex`: the `[[hooks.…]]` block of config.toml and the entries of hooks.json. */
function removeCodex(codexDir: string): RemovalAction[] {
  const out: RemovalAction[] = [];
  // hooks.json is a file the person had (install only edits an existing one): never deleted.
  const json = removeJsonHooks(join(codexDir, "hooks.json"));
  if (json) out.push(json.remove ? { file: json.file, content: "{}\n" } : json);
  const toml = removeMarked(join(codexDir, "config.toml"), CODEX_HOOK_START, CODEX_HOOK_END, "");
  if (toml) out.push(toml);
  return out;
}

/** The manifest install wrote whole for Copilot. */
function removeCopilot(dir: string | undefined): RemovalAction | undefined {
  const file = planCopilotHooks(undefined, dir).file;
  const text = read(file);
  if (text === undefined) return undefined;
  return /\bhook post-(?:search|git)\b/.test(text) ? { file, remove: true } : { file, skip: "it holds no ClarifyDoc hook command, so it is not ours to delete" };
}

function removeSkills(dir: string): RemovalAction[] {
  const out: RemovalAction[] = [];
  for (const p of planSkills(dir, dir)) {
    const text = read(p.file);
    if (text === undefined) continue;
    const name = /^---\nname: (clarifydoc-[\w-]+)\n/.exec(text)?.[1];
    out.push(name && p.file.includes(name) && text.includes("Uses the `clarifydoc` MCP server.") ? { file: p.file, remove: true } : { file: p.file, skip: "it is not a skill ClarifyDoc wrote" });
  }
  return out;
}

/** The plan of a removal: what would change, nothing written. */
export function planRemoval(opts: RemovalOptions): RemovalAction[] {
  const root = resolve(opts.root);
  const clients = opts.clients ?? CLIENTS;
  overlay = new Map();
  try {
    return planRemovalWith(opts, root, clients);
  } finally {
    overlay = new Map();
  }
}

function planRemovalWith(opts: RemovalOptions, root: string, clients: readonly Client[]): RemovalAction[] {
  const done = new Map<string, RemovalAction>();
  const attempt = (label: string, f: () => RemovalAction | RemovalAction[] | undefined) => {
    let made: RemovalAction[];
    try {
      const r = f();
      made = r === undefined ? [] : Array.isArray(r) ? r : [r];
    } catch (e) {
      made = [{ file: label, skip: `could not be read: ${e instanceof Error ? e.message : String(e)}` }];
    }
    for (const a of made) {
      if (a.skip) {
        if (!done.has(a.file)) done.set(a.file, a);
        continue;
      }
      overlay.set(a.file, a.remove ? null : (a.content ?? null));
      done.set(a.file, a);
    }
  };
  if (opts.plugin) {
    const dir = resolve(opts.plugin.dir);
    attempt(dir, () => {
      if (read(join(dir, "plugin.json")) === undefined || !/"name": "clarifydoc"/.test(read(join(dir, "plugin.json"))!)) return undefined;
      return planPlugin(dir, opts.plugin!.tools).filter((p) => existsSync(p.file)).map((p) => ({ file: p.file, remove: true, stop: dirname(dir) }));
    });
    return [...done.values()];
  }
  // Hooks before the MCP entry: a Codex config.toml holds both, and its table's end would run into the hook block's start marker.
  if (opts.hooks !== false) {
    attempt("hooks", () => {
      const acts: RemovalAction[] = [];
      // The same rule install's planHooks uses for Claude Code's hooks.
      const claude = clients.includes("claude-code") || (!clients.includes("codex") && !clients.includes("copilot") && !clients.includes("vscode")) ? removeJsonHooks(planClaudeHooks(root).file) : undefined;
      if (claude) acts.push(claude);
      if (clients.includes("codex")) acts.push(...removeCodex(opts.codexDir ?? join(homedir(), ".codex")));
      if (clients.includes("copilot") || clients.includes("vscode")) {
        const copilot = removeCopilot(opts.copilotDir);
        if (copilot) acts.push(copilot);
      }
      return acts;
    });
  }
  if (opts.mcp !== false) for (const c of clients) attempt(c, () => removeMcpEntry(c, root));
  if (opts.skills !== false) attempt("skills", () => removeSkills(join(root, ".claude", "skills")));
  if (opts.gitHooks !== false) {
    attempt("git hooks", () => {
      let dir: string;
      try {
        dir = gitHooksDir(root);
      } catch {
        return undefined; // not a git repository: no hooks of ours
      }
      return planGitHooks(root, { hooksDir: dir })
        .map((p) => removeMarked(p.file, HOOK_START, HOOK_END, "", (n) => n.trim() === "#!/bin/sh"))
        .filter((a): a is RemovalAction => !!a)
        .map((a) => ({ ...a, keepDir: true }));
    });
  }
  if (opts.guidance !== false) {
    const files = typeof opts.guidance === "string" ? [opts.guidance] : ["AGENTS.md", "CLAUDE.md"];
    for (const f of files) attempt(f, () => removeMarked(join(root, f), GUIDANCE_START, GUIDANCE_END, ""));
  }
  return [...done.values()];
}

/** Remove empty directories upward from `dir`, never leaving the project or the home directory's own tree. */
function pruneEmptyDirs(dir: string, stops: readonly string[]): void {
  let d = dir;
  while (!stops.some((s) => resolve(s) === resolve(d)) && stops.some((s) => resolve(d).startsWith(resolve(s) + sep))) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}

/** Write the removal (or, with `print`, only report it). */
export function applyRemoval(actions: readonly RemovalAction[], print: boolean, root: string): RemovalReport {
  const report: RemovalReport = { removed: [], edited: [], skipped: [], errors: [] };
  for (const a of actions) {
    if (a.skip) {
      report.skipped.push({ file: a.file, reason: a.skip });
      continue;
    }
    try {
      if (a.remove) {
        if (!print) {
          rmSync(a.file, { force: true });
          if (!a.keepDir) pruneEmptyDirs(dirname(a.file), [root, homedir(), ...(a.stop ? [a.stop] : [])]);
        }
        report.removed.push(a.file);
      } else if (a.content !== undefined) {
        if (!print) {
          mkdirSync(dirname(a.file), { recursive: true });
          writeFileSync(a.file, a.content);
        }
        report.edited.push(a.file);
      }
    } catch (e) {
      report.errors.push({ file: a.file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** The report as lines for a terminal. */
export function renderRemovalReport(report: RemovalReport, print: boolean): string[] {
  const out: string[] = [];
  const verb = print ? ["would delete", "would edit"] : ["deleted", "edited"];
  for (const f of report.removed) out.push(`${verb[0]} ${f}`);
  for (const f of report.edited) out.push(`${verb[1]} ${f}`);
  for (const s of report.skipped) out.push(`left ${s.file} as it is: ${s.reason}`);
  for (const e of report.errors) out.push(`error ${e.file}: ${e.error}`);
  if (!out.length) out.push("nothing of ClarifyDoc's to remove");
  return out;
}
