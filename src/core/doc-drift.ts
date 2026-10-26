/**
 * Doc drift: what the project's Markdown says that the tree no longer bears
 * out — a file path that is gone, a route nothing serves, a member a project
 * class no longer has. Read from inline code spans and links only: fenced
 * blocks hold examples and commands (`node dist/cli.js`) about build output.
 *
 * Every finding is an accusation, so each is guarded: a path counts only when
 * it is written as a path into this tree (its first folder exists, or it is a
 * relative link); a route only when its path begins like one of the
 * project's own; a member only on a class the project defines and whose
 * members the analysis read. Git then says how sure: a path history shows was
 * deleted or renamed is EXTRACTED, with the commit or the new name; one it
 * never knew is INFERRED — perhaps a plan, not a drift.
 */
import type { Confidence } from "../types/analysis.js";
import { escapeRegex } from "../extractors/plugins/shared/path-utils.js";

export interface DocReference {
  doc: string;
  line: number;
  kind: "path" | "route" | "member";
  text: string;
  /** For links: the target, relative to the doc. */
  link?: boolean;
}

export interface DocDriftFinding extends DocReference {
  reason: string;
  confidence: Confidence;
  /** The file it was renamed to, when history says. */
  renamedTo?: string;
}

export interface DocDriftReport {
  docs: number;
  references: number;
  findings: DocDriftFinding[];
  /**
   * The references the tree bears out, resolved to the analyzed file each
   * names — a path, the file serving a route, the file declaring a class —
   * so a change to that file can say which documents to update. Capped.
   */
  links?: DocLink[];
}

/** A document naming an analyzed file: by its path, a route it serves, or a member of a class it declares. */
export interface DocLink {
  doc: string;
  line: number;
  kind: DocReference["kind"];
  /** The reference as written. */
  text: string;
  /** The analyzed file it names. */
  file: string;
}

/** What `resolveDocLinks` needs to know of the tree. */
export interface DocLinkContext {
  /** Whether a project-relative path is an analyzed file. */
  isAnalyzed(path: string): boolean;
  /** The file serving `METHOD normalized-path`, when one route does. */
  routeFile(key: string): string | undefined;
  normalize(path: string): string;
  /** The file declaring a class of that name, when exactly one does. */
  classFile(name: string): string | undefined;
}

/** At most this many links are kept: the per-file lists a change reads are short, a sprawling wiki is not. */
const MAX_DOC_LINKS = 5000;

/**
 * The references that resolve to an analyzed file: a path (relative to the
 * document or the root) that is one, a route a file serves, a `Class.member`
 * a file declares. One link per document, line and file.
 */
export function resolveDocLinks(refs: readonly DocReference[], ctx: DocLinkContext): DocLink[] {
  const out: DocLink[] = [];
  const seen = new Set<string>();
  const push = (r: DocReference, file: string | undefined): void => {
    if (!file || r.doc === file) return;
    const key = `${r.doc}\u0000${r.line}\u0000${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ doc: r.doc, line: r.line, kind: r.kind, text: r.text, file });
  };
  for (const r of refs) {
    if (out.length >= MAX_DOC_LINKS) break;
    if (r.kind === "path") {
      const raw = r.text.replace(/:\d+(?::\d+)?$/, "").replace(/#L?\d+.*$/, "").replace(/\/$/, "");
      const docDir = r.doc.includes("/") ? r.doc.slice(0, r.doc.lastIndexOf("/")) : "";
      const fromDoc = posix(`${docDir}/${raw}`);
      const fromRoot = posix(raw.replace(/^\//, ""));
      push(r, [fromDoc, fromRoot].find((p): p is string => p !== null && ctx.isAnalyzed(p)));
    } else if (r.kind === "route") {
      const m = METHOD.exec(r.text);
      if (m) push(r, ctx.routeFile(`${m[1]} ${ctx.normalize(m[2]!.replace(/[?#].*$/, ""))}`));
    } else {
      push(r, ctx.classFile(r.text.split(".")[0]!));
    }
  }
  return out;
}

/** Build output and dependencies: a path into them describes what a build makes, not the tree. */
const OUTPUT_DIR = /(?:^|\/)(?:dist|build|out|target|bin|obj|node_modules|vendor|coverage|\.next|\.nuxt|\.clarifydoc|\.venv|venv|__pycache__)(?:\/|$)/;
const PLACEHOLDER = /[*?{}<>$%[\]]|\.\.\.|^~|^-|^\//;
/** A name a how-to invents (`src/core/my-analyzer.ts`, `your-plugin/`): an example, not a reference. */
const EXAMPLE_NAME = /(?:^|\/)(?:my|your|example|sample-name|foo|bar|baz|some|new)[-_.]/i;
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/;
const HISTORY_PROSE = /\b(?:removed|deleted|renamed|deprecated|formerly|previously|no longer|replaced|moved from|was moved|dropped)\b/i;

/** Inline code spans and link targets, line by line, outside fenced blocks. */
export function docReferences(doc: string, text: string): DocReference[] {
  const out: DocReference[] = [];
  let fence: string | null = null;
  // A block a tool writes between markers (our own `<!-- clarifydoc:start -->`
  // section, `<!-- BEGIN x -->`) is regenerated output, not prose to hold to the tree.
  let generated: RegExp | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (generated) {
      if (generated.test(raw)) generated = null;
      return;
    }
    const g = fence ? null : /^\s*<!--\s*(?:([\w.-]+):start|BEGIN\b[^>]*?)\s*-->/i.exec(raw);
    if (g) {
      generated = g[1] ? new RegExp(`<!--\\s*${escapeRegex(g[1])}:end\\s*-->`, "i") : /<!--\s*END\b[^>]*-->/i;
      return;
    }
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return;
    }
    if (fence || /^\s{4,}\S/.test(raw)) return;
    // A line telling history ("removed field `Tag.colour`", "renamed from `x.py`") names what is gone on purpose.
    if (HISTORY_PROSE.test(raw)) return;
    for (const m of raw.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      const t = m[1]!.trim();
      if (METHOD.test(t)) out.push({ doc, line, kind: "route", text: t });
      else if (/^[A-Z][A-Za-z0-9_]*(?:\.|#)[a-z_][A-Za-z0-9_]*(?:\(\))?$/.test(t)) out.push({ doc, line, kind: "member", text: t.replace(/\(\)$/, "").replace("#", ".") });
      else if (looksLikePath(t)) out.push({ doc, line, kind: "path", text: t });
    }
    for (const m of raw.matchAll(/\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)) {
      const t = (m[1] ?? m[2]!).replace(/[#?].*$/, "");
      if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("#")) out.push({ doc, line, kind: "path", text: t, link: true });
    }
  });
  return out;
}

function looksLikePath(t: string): boolean {
  if (/\s|:\/\/|^@/.test(t) || PLACEHOLDER.test(t)) return false;
  const p = t.replace(/:\d+(?::\d+)?$/, "").replace(/#L?\d+.*$/, "");
  if (!p.includes("/")) return false;
  const last = p.replace(/\/$/, "").split("/").pop()!;
  return p.endsWith("/") || /\.[A-Za-z0-9]{1,6}$/.test(last);
}

export interface DocDriftContext {
  /** Whether a project-relative path exists on disk (file or directory). */
  exists(path: string): boolean;
  /** Top-level entries of the project root, to tell a path into this tree from one into another. */
  topLevel: ReadonlySet<string>;
  /** `METHOD normalized-path` of every route, and the first path segments they start with. */
  routes: ReadonlySet<string>;
  routeHeads: ReadonlySet<string>;
  normalize(path: string): string;
  /** Project classes by name: their member names, when the analysis read them. */
  classMembers: ReadonlyMap<string, ReadonlySet<string> | null>;
  /** What git knows of a path that is missing: deleted in a commit, or renamed. Null without history. */
  history?(path: string): { deletedIn?: string; renamedTo?: string } | null;
}

/** A project-relative path, or null when it climbs above the root (another repository: not ours to judge). */
const posix = (p: string): string | null => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
};

export function checkDocReferences(refs: readonly DocReference[], ctx: DocDriftContext): DocDriftFinding[] {
  const out: DocDriftFinding[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (r.kind === "path") {
      const raw = r.text.replace(/:\d+(?::\d+)?$/, "").replace(/#L?\d+.*$/, "").replace(/\/$/, "");
      const docDir = r.doc.includes("/") ? r.doc.slice(0, r.doc.lastIndexOf("/")) : "";
      const fromDoc = posix(`${docDir}/${raw}`);
      const fromRoot = posix(raw.replace(/^\//, ""));
      if ((fromDoc !== null && ctx.exists(fromDoc)) || (fromRoot !== null && ctx.exists(fromRoot))) continue;
      // A path into this tree: a relative link, or one whose first folder is here.
      const candidate = r.link ? fromDoc : fromRoot;
      if (!candidate || OUTPUT_DIR.test(candidate) || EXAMPLE_NAME.test(candidate)) continue;
      if (!r.link && !ctx.topLevel.has(candidate.split("/")[0]!)) continue;
      const key = `path ${r.doc} ${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const h = ctx.history?.(candidate) ?? null;
      out.push({
        ...r,
        reason: h?.renamedTo ? `renamed to ${h.renamedTo}` : h?.deletedIn ? `deleted in ${h.deletedIn}` : `no such ${r.link ? "link target" : "path"}`,
        confidence: h?.renamedTo || h?.deletedIn ? "EXTRACTED" : "INFERRED",
        ...(h?.renamedTo ? { renamedTo: h.renamedTo } : {}),
      });
    } else if (r.kind === "route") {
      const m = METHOD.exec(r.text)!;
      const path = m[2]!.replace(/[?#].*$/, "");
      const head = path.split("/").filter(Boolean)[0];
      if (!head || !ctx.routeHeads.has(head.toLowerCase())) continue;
      if (ctx.routes.has(`${m[1]} ${ctx.normalize(path)}`)) continue;
      out.push({ ...r, reason: "no route serves it", confidence: "INFERRED" });
    } else {
      const [cls, member] = r.text.split(".");
      const members = ctx.classMembers.get(cls!);
      if (!members || members.has(member!)) continue;
      out.push({ ...r, reason: `${cls} has no member ${member}`, confidence: "INFERRED" });
    }
  }
  return out;
}
