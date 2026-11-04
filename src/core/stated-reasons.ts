/**
 * The reasons a codebase states without a decision record: a plain comment
 * that says why ("because …", "so that …", "to avoid …"), and the body of a
 * commit that changed the file. Read on demand (the MCP server), never during
 * `analyze`; no model, no network.
 *
 * These are what someone wrote down, not decisions: the server labels them
 * "reason stated in a comment" / "in a commit", apart from the decision
 * records and `WHY:` markers of context-docs.ts. Precision over recall — a
 * connective only counts in a shape that states a cause or a purpose ("since
 * the API returns …", never "since v2.3"; "otherwise … would break", never
 * "otherwise return the default"), and licence headers, commented-out code
 * and generated files are not read.
 *
 * Comment syntax is the language's own (`LanguagePluginMeta.docComments`);
 * core knows none of its own.
 */

import { execFile } from "child_process";
import type { DocCommentSpec } from "../types/language-plugin.js";
import { GIT_SAFE_DIFF, gitArgs } from "./git-safe.js";

/** Longest quoted comment or commit paragraph, in characters. */
export const MAX_REASON_LENGTH = 300;

/**
 * A verb that makes the words after `since` a clause, not a point in time. The past tense is left out:
 * "since the model was trained" is a time far more often than a cause.
 */
const AUX = String.raw`(?:is|are|isn't|aren't|has|have|hasn't|haven't|can|can't|cannot|could|couldn't|does|doesn't|do|don't|did|didn't|will|won't|would|wouldn't|must|may|might|should|shouldn't|needs?|requires?|expects?|returns?|only|always|never|already)`;

/** The shapes that state a cause or a purpose. */
const REASONS: readonly RegExp[] = [
  /\bbecause\b/i,
  /\bso that\b/i,
  /\bin order to\b/i,
  /\bto (?:avoid|prevent)\b/i,
  /\bwork(?:s|ed)?[- ]?around\b/i,
  // Opening a sentence or an aside ("Needed for …", "- required by …", "(needed for …)"), or after `is`;
  // "those required by a tag" in the middle of a sentence describes data, not a reason.
  /(?:^|[-:;,(—]\s*|\b(?:is|are|only|also)\s+)(?:required|needed|necessary) (?:by|for)\b/i,
  /\bdue to\b/i,
  /\bfor (?:this|that|the same) reason\b|\bthe reason (?:is|why)\b/i,
  /\bfor (?:backwards?[- ])?compat(?:ibility)?\b/i,
  // A consequence after `otherwise` — "otherwise return x" describes a branch.
  /\botherwise\b[^.;]{0,80}?\b(?:would|will|could|might|breaks?|fails?|crash(?:es)?|throws?|hangs?|loses?|leaks?|deadlocks?)\b/i,
  /\b(?:can't|cannot|can not|couldn't)\b[^.;]{0,80}?,? so\b/i,
  /\b(?:has|have|must|needs?) to\b[^.;]{0,60}?\bor(?: else)?\b[^.;]{0,40}?\b(?:would|will|breaks?|fails?|crash(?:es)?|throws?|errors?)\b/i,
  // `since` with a subject and a verb: "since the API returns null", "since we hold the lock".
  new RegExp(String.raw`\bsince\s+(?:(?:we|it|they|this|that|these|those|there|you|I)\b(?!\s+(?:was|were|had)\b)|(?!then\b|when\b|v?\d|version\b|release\b|the (?:first|last|start|beginning)\b)(?:[A-Za-z][\w'’-]*\s+){1,4}?${AUX}\b)`, "i"),
];

/** Whether `text` states a reason — the index of the first connective, or -1. */
function reasonAt(text: string): number {
  let at = -1;
  for (const re of REASONS) {
    const m = re.exec(text);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

export function statesReason(text: string): boolean {
  return reasonAt(text) >= 0;
}

/** `text` cut to `MAX_REASON_LENGTH` around its first connective, from the start of that sentence. */
function excerpt(text: string): string {
  if (text.length <= MAX_REASON_LENGTH) return text;
  const at = Math.max(0, reasonAt(text));
  const before = text.slice(0, at);
  const sentence = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  let start = sentence >= 0 ? sentence + 2 : 0;
  if (at - start > MAX_REASON_LENGTH - 60) start = at - 40;
  const cut = text.slice(start, start + MAX_REASON_LENGTH - 2);
  const end = cut.length < text.length - start ? cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_REASON_LENGTH / 2)) : cut;
  return `${start > 0 ? "…" : ""}${end}${start + end.length < text.length ? "…" : ""}`;
}

const LICENCE = /\b(?:copyright|licen[cs]ed?|spdx-license|all rights reserved)\b/i;
const GENERATED = /\b(?:code generated|@generated|auto-?generated|do not edit)\b/i;
/** A comment row that reads as code: ends in `;`, `{`, `}`, `(` or `,`, opens with a keyword and a symbol, or assigns or calls. */
const CODE_ROW = /[;{}(,]\s*$|^(?:import|from|export|const|let|var|return|def|fn|func|function|class|public|private|await|raise|throw)\b[^.]*[=({:]|^(?:if|for|while|elif|else)\b[^.]*[({:]\s*$|^[\w.$[\]]+\s*(?:[-+*/]?=[^=]|\([^)]*\)\s*;?$)|=>|^[)\]}]/;

export interface FunctionSpan {
  name: string;
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
}

export interface ReasonComment {
  file: string;
  /** 1-based first and last line of the comment block. */
  line: number;
  endLine: number;
  /** The comment's prose, trimmed and capped. */
  text: string;
  /** The function the comment sits directly above, or else the innermost one it sits in. */
  anchor?: FunctionSpan & { where: "above" | "inside" };
}

interface Block {
  start: number;
  end: number;
  rows: string[];
}

/** The whole-line comment blocks of `lines` in the language's comment shapes; a comment after code on its line is left out. */
function commentBlocks(lines: readonly string[], spec: DocCommentSpec): Block[] {
  const out: Block[] = [];
  const prefixes = [...(spec.line ?? [])].sort((a, b) => b.length - a.length);
  let run: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const opener = (spec.block ?? []).find(([open]) => t.startsWith(open));
    if (opener) {
      run = null;
      const [open, close] = opener;
      const rows: string[] = [];
      let j = i;
      let closed = false;
      for (; j < lines.length && j - i < 80; j++) {
        let row = j === i ? t.slice(open.length) : lines[j]!.trim();
        const end = row.indexOf(close);
        if (end >= 0) {
          row = row.slice(0, end);
          closed = true;
        }
        rows.push(row.replace(/^\*(?!\))\s?/, ""));
        if (closed) break;
      }
      // An opener that never closes is not a comment (a Lua `{-1, 2}`).
      if (closed) out.push({ start: i, end: j, rows });
      i = closed ? j : i;
      continue;
    }
    const prefix = i === 0 && t.startsWith("#!") ? undefined : prefixes.find((p) => t.startsWith(p));
    if (!prefix) {
      run = null;
      continue;
    }
    const row = t.slice(prefix.length);
    if (run && run.end === i - 1) {
      run.end = i;
      run.rows.push(row);
    } else {
      run = { start: i, end: i, rows: [row] };
      out.push(run);
    }
  }
  return out;
}

/**
 * The comments of one file that state a reason, each the whole block it is in,
 * anchored to the function it sits directly above (blank and attribute lines
 * between) or else the innermost one it sits in. `functions` are the file's
 * analyzed spans. Nothing in a generated file.
 */
export function findReasonComments(source: string, file: string, spec: DocCommentSpec | undefined, functions: readonly FunctionSpan[]): ReasonComment[] {
  if (!spec || !REASONS.some((re) => re.test(source))) return [];
  const lines = source.split(/\r?\n/);
  if (GENERATED.test(lines.slice(0, 5).join("\n"))) return [];
  const out: ReasonComment[] = [];
  for (const b of commentBlocks(lines, spec)) {
    const rows = b.rows.map((r) => r.replace(/^[*#!/\s]+/, "").replace(/\s*\*+\/?\s*$/, "").trim()).filter(Boolean);
    const code = rows.filter((r) => CODE_ROW.test(r));
    if (code.length * 2 >= rows.length) continue;
    const prose = rows.filter((r) => !CODE_ROW.test(r)).join(" ").replace(/\s+/g, " ").trim();
    if (!statesReason(prose) || LICENCE.test(prose) || GENERATED.test(prose)) continue;
    const anchor = anchorOf(lines, b, spec, functions);
    out.push({ file, line: b.start + 1, endLine: b.end + 1, text: excerpt(prose), ...(anchor ? { anchor } : {}) });
  }
  return out;
}

function anchorOf(lines: readonly string[], b: Block, spec: DocCommentSpec, functions: readonly FunctionSpan[]): ReasonComment["anchor"] | undefined {
  const first = b.start + 1;
  const last = b.end + 1;
  const below = functions
    .filter((f) => f.line > last && f.line - last <= 20)
    .sort((x, y) => x.line - y.line)[0];
  if (below && lines.slice(last, below.line - 1).every((l) => !l.trim() || spec.attribute?.test(l))) return { ...below, where: "above" };
  const inside = functions.filter((f) => f.line <= first && f.endLine >= last).sort((x, y) => x.endLine - x.line - (y.endLine - y.line))[0];
  return inside ? { ...inside, where: "inside" } : undefined;
}

export interface CommitReason {
  sha: string;
  /** YYYY-MM-DD, author date. */
  date: string;
  subject: string;
  /** From `(#123)` in the subject or "Merge pull request #123". */
  pr?: number;
  /** The body paragraph that states the reason, capped. */
  excerpt: string;
}

export interface CommitReasons {
  status: "ok" | "no-git" | "failed";
  /** The clone holds only part of the history. */
  shallow?: boolean;
  /** Whether the commits were those touching the asked lines, or the whole file's. */
  scope: "lines" | "file";
  /** Commits read. */
  scanned: number;
  reasons: CommitReason[];
}

/** Trailers, quotes and fences: never the author's own reason. */
const NOT_PROSE = /^(?:[A-Z][\w-]*-by:|Change-Id:|Co-authored-by:|Signed-off-by:|>|```|~~~)/i;

/** The first body paragraph that states a reason, trailers and quoted lines left out; null when none does. */
export function reasonParagraph(body: string): string | null {
  let fenced = false;
  for (const para of body.split(/\r?\n\s*\r?\n/)) {
    const rows: string[] = [];
    for (const row of para.split(/\r?\n/)) {
      const t = row.trim();
      if (/^(?:```|~~~)/.test(t)) fenced = !fenced;
      if (fenced || NOT_PROSE.test(t)) continue;
      rows.push(t);
    }
    const text = rows.join(" ").replace(/\s+/g, " ").trim();
    if (text && statesReason(text)) return excerpt(text);
  }
  return null;
}

const BOT = /\[bot\]|dependabot|renovate/i;
const DEPENDENCY_BUMP = /^(?:bump|update dependency|chore\(deps)/i;

function runGit(root: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", gitArgs(root, args), { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.toString()));
  });
}

const FORMAT = "--format=%x1e%h%x1f%ad%x1f%an%x1f%s%x1f%b%x1f";

/**
 * The reasons stated in the bodies of the commits that changed `file`
 * (project-relative): the last `maxCommits` of its history, renames followed,
 * or with `lines` the few that touched that range (`git log -L`, falling back
 * to the file's log when git cannot trace it). Bot and dependency-bump commits
 * are skipped. Bounded by a timeout per git call.
 */
export async function commitReasons(
  root: string,
  file: string,
  { lines, maxCommits = 30, rangeCommits = 10, timeoutMs = 5000 }: { lines?: readonly [number, number]; maxCommits?: number; rangeCommits?: number; timeoutMs?: number } = {},
): Promise<CommitReasons> {
  const shallow = await runGit(root, ["rev-parse", "--is-shallow-repository"], timeoutMs);
  if (shallow === null) return { status: "no-git", scope: lines ? "lines" : "file", scanned: 0, reasons: [] };
  const flags = shallow.trim() === "true" ? { shallow: true } : {};
  let scope: CommitReasons["scope"] = "file";
  let out: string | null = null;
  if (lines && lines[0] >= 1 && lines[1] >= lines[0]) {
    out = await runGit(root, ["log", `-L${lines[0]},${lines[1]}:${file}`, "-s", ...GIT_SAFE_DIFF, `-n${rangeCommits}`, "--date=short", FORMAT], timeoutMs);
    if (out !== null) scope = "lines";
  }
  out ??= await runGit(root, ["log", "--follow", `-n${maxCommits}`, "--date=short", FORMAT, "--", file], timeoutMs);
  if (out === null) return { status: "failed", ...flags, scope, scanned: 0, reasons: [] };
  const reasons: CommitReason[] = [];
  let scanned = 0;
  for (const record of out.split("\x1e")) {
    const [sha, date, author, subject, body] = record.split("\x1f");
    if (!sha?.trim() || subject === undefined) continue;
    scanned++;
    if (BOT.test(author ?? "") || DEPENDENCY_BUMP.test(subject)) continue;
    const text = reasonParagraph(body ?? "");
    if (!text) continue;
    const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)\b/.exec(subject)?.[1];
    reasons.push({ sha: sha.trim(), date: date ?? "", subject: subject.trim(), ...(pr ? { pr: Number(pr) } : {}), excerpt: text });
  }
  return { status: "ok", ...flags, scope, scanned, reasons };
}
