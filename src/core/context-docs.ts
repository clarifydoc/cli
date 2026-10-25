/**
 * The documents that say WHY the code is the way it is — decision records
 * (ADRs), the single documents that frame a codebase (ARCHITECTURE, GLOSSARY,
 * DOMAIN …), schema dumps, the documents a team declares in
 * `.clarifydoc/config.json` `context` — and the decision markers written in
 * comments (`WHY:`, `DECISION:`, `TRADEOFF:`, `RATIONALE:`, `REJECTED:`,
 * `ADR:`). Read on demand (the MCP server), never during `analyze`.
 *
 * A document governs the analyzed files it names by path; it is judged stale
 * when one of them was committed after the document last was — the decision
 * may no longer describe the code. Facts only: a document naming no file is
 * never judged, and without git nothing is.
 */

import { execFile } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "path";
import { gitArgs } from "./git-safe.js";

export interface ContextDocInput {
  path: string;
  /** When to consult it — shown beside it. */
  description?: string;
}

export interface ContextDoc {
  /** Project-relative, posix. */
  path: string;
  kind: "decision" | "context" | "schema";
  title: string;
  bytes: number;
  /** From the team's declaration: when to consult it. */
  description?: string;
  /** A decision record's own `Status:` (Accepted, Superseded by …), when it states one. */
  status?: string;
}

export interface DecisionMarker {
  file: string;
  line: number;
  tag: string;
  text: string;
}

/** Where decision records live, and the single documents that frame a codebase. */
const ADR_DIRS = /(?:^|\/)(?:adrs?|decisions|architecture\/decisions|decision-records|rfcs?)$/i;
const DOC_EXT = /\.(?:md|mdx|adoc|rst|txt)$/i;
const CONTEXT_FILES = /^(?:architecture|glossary|domain|design|context|conventions|ubiquitous-language)(?:[-_.][\w-]+)?\.(?:md|mdx|adoc|rst|txt)$/i;
const SCHEMA_DUMPS = /(?:^|\/)(?:db\/schema\.rb|db\/structure\.sql|schema\.sql|database\/schema\.sql|structure\.sql|schema\.graphql|schema\.graphqls|prisma\/schema\.prisma)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "bin", "obj", "coverage", "__pycache__", "venv"]);
const MAX_DOCS = 300;
const MAX_DEPTH = 6;

/** A path inside `root`, project-relative and posix, or null when it would leave it. */
export function insideRoot(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  const rel = normalize(path).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
  const back = relative(root, join(root, rel));
  return back.startsWith("..") ? null : rel;
}

function titleOf(head: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? /^title:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? fallback;
}

/** `Status: Accepted` or a `## Status` section's first line. */
function statusOf(head: string): string | undefined {
  const inline = /^\s*\**status\**\s*:\s*(.+)$/im.exec(head)?.[1];
  const section = /^#{2,3}\s*status\s*\n+\s*([^\n#][^\n]*)/im.exec(head)?.[1];
  const s = (inline ?? section)?.replace(/[*_`]/g, "").trim();
  return s ? s.slice(0, 80) : undefined;
}

/**
 * The context documents under `root`: decision records first, then framing
 * documents, then schema dumps, each by path. Hidden and build directories
 * are not walked; declared documents are added (with their description)
 * wherever they are, as long as they stay inside the root.
 */
export async function findContextDocs(root: string, declared: readonly ContextDocInput[] = []): Promise<ContextDoc[]> {
  const found = new Map<string, ContextDoc>();
  const add = async (path: string, kind: ContextDoc["kind"], description?: string) => {
    const full = join(root, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    let title = name;
    let status: string | undefined;
    if (kind !== "schema") {
      const head = (await readFile(full, "utf8").catch(() => "")).slice(0, 4000);
      title = titleOf(head, name);
      if (kind === "decision") status = statusOf(head);
    }
    found.set(path, { path, kind, title, bytes: info.size, ...(description ? { description } : {}), ...(status ? { status } : {}) });
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.size >= MAX_DOCS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const rel = relative(root, dir).split(sep).join("/");
    const inAdrDir = ADR_DIRS.test(rel);
    for (const e of entries) {
      if (found.size >= MAX_DOCS) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      const kind = inAdrDir && DOC_EXT.test(e.name) ? "decision" : CONTEXT_FILES.test(e.name) ? "context" : SCHEMA_DUMPS.test(path) ? "schema" : null;
      if (kind) await add(path, kind);
    }
  };
  await walk(root, 0);
  for (const d of declared) {
    const path = insideRoot(root, d.path);
    if (!path) continue;
    const existing = found.get(path);
    if (existing) {
      if (d.description) existing.description = d.description;
      continue;
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await add(path, ADR_DIRS.test(dir) ? "decision" : SCHEMA_DUMPS.test(path) ? "schema" : "context", d.description);
  }
  const order = { decision: 0, context: 1, schema: 2 };
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.path < b.path ? -1 : 1));
}

const MARKER = /(?:\/\/|\/\*+|^\s*\*|#|--|;|<!--|^\s*')\s*(WHY|DECISION|TRADEOFF|RATIONALE|REJECTED|ADR)\s*:\s*(\S.*?)\s*(?:\*\/|-->)?\s*$/;
const MARKER_GATE = /\b(?:WHY|DECISION|TRADEOFF|RATIONALE|REJECTED|ADR)\s*:/;

/** The decision markers in one file's comments: an upper-case tag after a comment leader, then a colon. */
export function findDecisionMarkers(text: string, file: string): DecisionMarker[] {
  if (!MARKER_GATE.test(text)) return [];
  const out: DecisionMarker[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]!);
    if (m) out.push({ file, line: i + 1, tag: m[1]!, text: m[2]!.slice(0, 200) });
  }
  return out;
}

/**
 * The analyzed files a document names: a token that is a file's path, or a
 * unique path suffix (`orders/service.ts` for `src/orders/service.ts`), or a
 * file name with an extension that only one analyzed file has. Capped.
 */
export function governedFiles(text: string, files: readonly string[], cap = 50): string[] {
  const byPath = new Set(files);
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    const list = byName.get(name);
    if (list) list.push(f);
    else byName.set(name, [f]);
  }
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w@$.\-/]*[\w-]\.[A-Za-z][\w]{0,9}\b/g)) {
    if (out.size >= cap) break;
    const token = m[0].replace(/^\.?\//, "");
    if (byPath.has(token)) {
      out.add(token);
      continue;
    }
    const name = token.slice(token.lastIndexOf("/") + 1);
    const same = byName.get(name);
    if (!same) continue;
    const hits = token.includes("/") ? same.filter((f) => f.endsWith(`/${token}`)) : same;
    if (hits.length === 1) out.add(hits[0]!);
  }
  return [...out];
}

/**
 * The last commit time (ms) of each path, from one `git log` over them
 * (newest first, so a path's first sighting is its last change). Empty
 * without git or when the call fails.
 */
export function lastCommitTimes(root: string, paths: readonly string[], timeoutMs = 5000): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!paths.length) return Promise.resolve(out);
  const args = gitArgs(root, ["log", "--relative", "--format=%x00%ct", "--name-only", "--", ...paths.slice(0, 2000)]);
  return new Promise((resolve) => {
    execFile("git", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(out);
      let at = 0;
      for (const line of stdout.toString().split("\n")) {
        if (line.startsWith("\0")) at = Number(line.slice(1)) * 1000;
        else if (line && at && !out.has(line)) out.set(line, at);
      }
      resolve(out);
    });
  });
}

export interface DocStaleness {
  /** The analyzed files it names. */
  governs: string[];
  /** Of those, the ones committed after the document last was, newest first. */
  changedSince: Array<{ file: string; at: number }>;
  /** When the document itself last was committed; absent without git history for it. */
  writtenAt?: number;
}

/** For each document, the files it names and which of them moved on since it was written. */
export async function judgeStaleness(root: string, docs: readonly ContextDoc[], files: readonly string[]): Promise<Map<string, DocStaleness>> {
  const out = new Map<string, DocStaleness>();
  const governed = new Map<string, string[]>();
  for (const d of docs) {
    if (d.kind === "schema") continue;
    const text = await readFile(join(root, d.path), "utf8").catch(() => "");
    const g = governedFiles(text, files);
    if (g.length) governed.set(d.path, g);
  }
  const times = await lastCommitTimes(root, [...new Set([...governed.keys(), ...[...governed.values()].flat()])]);
  for (const [path, governs] of governed) {
    const writtenAt = times.get(path);
    const changedSince = writtenAt === undefined ? [] : governs.map((file) => ({ file, at: times.get(file) ?? 0 })).filter((x) => x.at > writtenAt).sort((a, b) => b.at - a.at);
    out.set(path, { governs, changedSince, ...(writtenAt !== undefined ? { writtenAt } : {}) });
  }
  return out;
}
