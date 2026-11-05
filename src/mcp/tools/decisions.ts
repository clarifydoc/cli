import { readFile } from "fs/promises";
import { join } from "path";
import type { McpTool } from "../protocol.js";
import type { AnalysisStore, LoadedAnalysis } from "../store.js";
import { bulletList, fenced, joinLines, plural, section, stringArg } from "../format.js";
import { mustResolveFile, requireAnalysis, type ToolContext } from "./context.js";
import { noResults } from "../empty.js";
import { findContextDocs, findDecisionMarkers, judgeStaleness, type ContextDoc, type DecisionMarker, type DocStaleness } from "../../core/context-docs.js";
import { loadProjectConfig } from "../../core/project-config.js";
import { commitReasons, findReasonComments, type CommitReason, type CommitReasons, type FunctionSpan, type ReasonComment } from "../../core/stated-reasons.js";
import { manifestFor } from "../../extractors/registry.js";
import type { FileAnalysis } from "../../types/analysis.js";

const MAX_READ = 30_000;
/** Rows of each stated-reason lane. */
const MAX_REASON_COMMENTS = 3;
const MAX_REASON_COMMITS = 2;
/** Analyzed files read for markers before the scan stops (it says so). */
const MARKER_FILES = 20_000;

export interface ContextIndex {
  docs: ContextDoc[];
  staleness: Map<string, DocStaleness>;
  /** The decision markers of every analyzed file — read on first use, the costly part. */
  markers: () => Promise<{ markers: DecisionMarker[]; capped: boolean }>;
}

const cache = new WeakMap<AnalysisStore, { at: number; loaded: LoadedAnalysis; index: Promise<ContextIndex> }>();

/**
 * The project's context documents and their staleness, and (lazily) the
 * decision markers in its analyzed files — reused for half a minute while the
 * same analysis is loaded, so a burst of calls reads the tree once.
 */
export function contextIndex(store: AnalysisStore, loaded: LoadedAnalysis, ttlMs = 30_000): Promise<ContextIndex> {
  const hit = cache.get(store);
  if (hit && hit.loaded === loaded && Date.now() - hit.at < ttlMs) return hit.index;
  const index = (async () => {
    const root = store.projectRoot;
    const declared = loadProjectConfig(root).config.context ?? [];
    const docs = await findContextDocs(root, declared);
    const files = loaded.summary.files ?? [];
    const staleness = await judgeStaleness(root, docs, files);
    let scan: Promise<{ markers: DecisionMarker[]; capped: boolean }> | null = null;
    const markers = () =>
      (scan ??= (async () => {
        const found: DecisionMarker[] = [];
        for (const f of files.slice(0, MARKER_FILES)) found.push(...(await markersIn(root, f)));
        return { markers: found, capped: files.length > MARKER_FILES };
      })());
    return { docs, staleness, markers };
  })();
  cache.set(store, { at: Date.now(), loaded, index });
  return index;
}

/** The decision markers of one project file. */
export async function markersIn(root: string, file: string): Promise<DecisionMarker[]> {
  return findDecisionMarkers(await readFile(join(root, file), "utf8").catch(() => ""), file);
}

/** The documents naming `file` and the markers in it, as rows for `clarifydoc_file`; [] when none. */
export async function decisionsAbout(store: AnalysisStore, loaded: LoadedAnalysis, file: string, limit: number): Promise<string[]> {
  const index = await contextIndex(store, loaded);
  const docs = index.docs.filter((d) => index.staleness.get(d.path)?.governs.includes(file));
  const markers = await markersIn(store.projectRoot, file);
  return [...bulletList(docs, limit, (d) => docRow(d, index.staleness.get(d.path))), ...bulletList(markers, limit, markerRow)];
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "names 3 files; 1 committed since it was: src/a.ts (2026-05-01)" — or "" for a document naming none. */
export function stalenessNote(s: DocStaleness | undefined): string {
  if (!s) return "";
  const names = `names ${plural(s.governs.length, "analyzed file")}`;
  if (s.writtenAt === undefined) return names;
  if (!s.changedSince.length) return `${names}, none changed since it was written`;
  const eg = s.changedSince.slice(0, 2).map((c) => `${c.file} (${day(c.at)})`).join(", ");
  return `${names}; ${s.changedSince.length} committed after it (${day(s.writtenAt)}): ${eg}${s.changedSince.length > 2 ? ", …" : ""} — it may be stale`;
}

function docRow(d: ContextDoc, s: DocStaleness | undefined): string {
  const note = stalenessNote(s);
  return `[${d.kind}] ${d.title} — ${d.path}${d.status ? ` · ${d.status}` : ""}${d.description ? ` — ${d.description}` : ""}${note ? ` · ${note}` : ""}`;
}

const markerRow = (m: DecisionMarker) => `${m.tag}: ${m.text} (${m.file}:${m.line})`;

export function contextDocsTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_context_docs",
    title: "Decisions and context documents",
    description: "Use for why code is so: decision records, WHY:/DECISION: comments and context docs, flagged when what they name changed; per `file`, reasons comments and commits state. `query` searches, `path` reads, `function` narrows.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        file: { type: "string" },
        function: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const index = await contextIndex(ctx.store, loaded);
      const root = ctx.store.projectRoot;
      const path = stringArg(args, "path");
      const fileArg = stringArg(args, "file");
      const query = stringArg(args, "query")?.toLowerCase();
      const functionArg = stringArg(args, "function");
      if (functionArg && !fileArg) throw new Error("`function` narrows a file — pass `file` too.");

      if (path) {
        const doc = index.docs.find((d) => d.path === path.replace(/^\.\//, ""));
        if (!doc) throw new Error(`"${path}" is not one of this project's context documents — call clarifydoc_context_docs with no arguments to list them.`);
        const body = await readFile(join(root, doc.path), "utf8").catch(() => null);
        if (body === null) throw new Error(`Could not read ${doc.path}.`);
        const s = index.staleness.get(doc.path);
        return {
          text: joinLines([
            `# ${doc.title} (${doc.path})`,
            ...(doc.status ? [`status: ${doc.status}`] : []),
            ...(doc.description ? [`consult: ${doc.description}`] : []),
            ...(s ? [stalenessNote(s), ...(s.governs.length ? [`files it names: ${s.governs.slice(0, 12).join(", ")}${s.governs.length > 12 ? ", …" : ""}`] : [])] : []),
            "",
            fenced(body.slice(0, MAX_READ), doc.path.endsWith(".md") ? "markdown" : ""),
            ...(body.length > MAX_READ ? [`… ${body.length - MAX_READ} more characters not shown.`] : []),
          ]),
        };
      }

      if (fileArg) {
        const file = mustResolveFile(loaded, fileArg);
        const docs = index.docs.filter((d) => index.staleness.get(d.path)?.governs.includes(file));
        const source = await readFile(join(root, file), "utf8").catch(() => "");
        const markers = findDecisionMarkers(source, file);
        const analysis = await ctx.store.fileAnalysis(file);
        const fn = functionArg ? mustResolveFunction(analysis, file, functionArg) : undefined;
        const terms = query?.split(/\s+/).filter(Boolean) ?? [];
        const { comments, unread } = reasonComments(source, file, analysis, fn);
        const commits = await commitReasons(root, file, fn ? { lines: [fn.line, fn.endLine] } : {});
        const shownComments = rank(comments, terms, (c) => `${c.text} ${c.anchor?.name ?? ""}`);
        const shownCommits = rank(commits.reasons, terms, (c) => `${c.subject} ${c.excerpt}`);
        const of = fn ? `${fn.name}() in ${file}` : file;
        if (!docs.length && !markers.length && !comments.length && !commits.reasons.length) {
          return {
            text: noResults({
              headline: `No decision record or context document names ${file}, it carries no decision marker, and no comment${fn ? ` in or above ${fn.name}()` : ""} or commit body states a reason${fn ? ` for lines ${fn.line}-${fn.endLine}` : ""}.`,
              holds: `The project has ${plural(index.docs.length, "context document")}. Comments were read for "because", "so that", "to avoid", "since <clause>"${unread ? ` (${unread})` : ""}; ${commitsLooked(commits, fn)}.`,
              next: [index.docs.length ? "clarifydoc_context_docs — list them" : undefined, `clarifydoc_file path="${file}"`],
            }),
          };
        }
        return {
          text: joinLines([
            docs.length || markers.length ? `# Decisions about ${of}` : `# Reasons stated about ${of} (no decision record or marker)`,
            "",
            ...section(`Documents naming it (${docs.length})`, bulletList(docs, 20, (d) => docRow(d, index.staleness.get(d.path)))),
            ...section(`Decision markers in it (${markers.length})`, bulletList(markers, 20, markerRow)),
            ...section(`Reasons stated in comments (${comments.length}) — not decisions`, topRows(shownComments, MAX_REASON_COMMENTS, commentRow)),
            unread ? `Comments: not read (${unread}).` : "",
            ...section(
              `Reasons stated in commits (${commits.reasons.length} of ${commits.scanned} read) — not decisions`,
              commits.reasons.length ? [...topRows(shownCommits, MAX_REASON_COMMITS, commitRow), ...(commits.shallow ? ["  (shallow clone: older history is not here)"] : [])] : [],
            ),
            !commits.reasons.length ? `Commits: ${commitsLooked(commits, fn)}.` : fn ? `Commits: ${commits.scope === "lines" ? `those touching lines ${fn.line}-${fn.endLine}` : "the file's (git could not trace the lines)"}.` : "",
          ]),
        };
      }

      if (query) {
        const terms = query.split(/\s+/).filter(Boolean);
        const hits: string[] = [];
        for (const d of index.docs) {
          if (hits.length > 120) break;
          const body = await readFile(join(root, d.path), "utf8").catch(() => "");
          const lower = `${d.title}\n${d.description ?? ""}\n${body}`.toLowerCase();
          if (!terms.every((t) => lower.includes(t))) continue;
          const lines = body.split(/\r?\n/).map((l, i) => ({ n: i + 1, l })).filter(({ l }) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3);
          hits.push(`- ${docRow(d, index.staleness.get(d.path))}`, ...lines.map(({ n, l }) => `  - L${n}: ${l.trim().slice(0, 160)}`));
        }
        const all = (await index.markers()).markers;
        const markers = all.filter((m) => terms.every((t) => `${m.tag} ${m.text} ${m.file}`.toLowerCase().includes(t)));
        if (!hits.length && !markers.length) {
          return {
            text: noResults({
              headline: `No context document or decision marker mentions all of "${query}".`,
              holds: `The project has ${plural(index.docs.length, "context document")} and ${plural(all.length, "decision marker")}.`,
              next: [terms.length > 1 ? `clarifydoc_context_docs query="${terms[0]}" — fewer terms` : undefined, "clarifydoc_search body=true — the code itself"],
            }),
          };
        }
        return {
          text: joinLines([
            `# Context mentioning "${query}"`,
            "",
            ...(hits.length ? [...hits, ""] : []),
            ...section(`Decision markers (${markers.length})`, bulletList(markers, 20, markerRow)),
          ]),
        };
      }

      const { markers, capped } = await index.markers();
      if (!index.docs.length && !markers.length) {
        return {
          text: noResults({
            headline: "No decision records, context documents or decision markers found.",
            holds: "Looked for ADR directories (adr/, decisions/, rfcs/), ARCHITECTURE/GLOSSARY/DOMAIN documents, schema dumps, `.clarifydoc/config.json` `context`, and WHY:/DECISION:/TRADEOFF: comments in the analyzed files.",
            next: ["clarifydoc_search body=true — doc comments in the code"],
          }),
        };
      }
      const stale = index.docs.filter((d) => index.staleness.get(d.path)?.changedSince.length).length;
      return {
        text: joinLines([
          `# Context documents (${index.docs.length})${stale ? ` — ${stale} may be stale` : ""}`,
          "",
          ...bulletList(index.docs, 40, (d) => docRow(d, index.staleness.get(d.path))),
          "",
          ...section(`Decision markers in code (${markers.length}${capped ? `, first ${MARKER_FILES} files read` : ""})`, bulletList(markers, 20, markerRow)),
          index.docs.length ? 'Next: clarifydoc_context_docs path="…" reads one; file="…" gives those about a file.' : "",
        ]),
      };
    },
  };
}

/** The file's functions and methods as spans, methods named `Class.method`. */
function spansOf(analysis: FileAnalysis | null): FunctionSpan[] {
  if (!analysis) return [];
  const out: FunctionSpan[] = [];
  for (const f of analysis.functions ?? []) if (!f.name.startsWith("<") && f.endLine >= f.line) out.push({ name: f.name, line: f.line, endLine: f.endLine });
  for (const c of analysis.classes ?? []) for (const m of c.methods ?? []) if (m.endLine >= m.line) out.push({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine });
  return out;
}

/** The function `name` names in the file — exactly, or a method by its own name when only one has it. */
function mustResolveFunction(analysis: FileAnalysis | null, file: string, name: string): FunctionSpan {
  const spans = spansOf(analysis);
  const exact = spans.filter((s) => s.name === name);
  const leaf = exact.length ? exact : spans.filter((s) => s.name.endsWith(`.${name}`));
  if (leaf.length === 1) return leaf[0]!;
  const names = (leaf.length ? leaf : spans).map((s) => `${s.name} (${s.line})`);
  throw new Error(
    leaf.length > 1
      ? `"${name}" names ${leaf.length} functions in ${file} — pass one of: ${names.slice(0, 10).join(", ")}`
      : `No function "${name}" in ${file}${names.length ? ` — it defines ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}` : ""}.`,
  );
}

/** The reason-stating comments of a file, narrowed to those in or directly above `fn`; `unread` says why none could be read. */
function reasonComments(source: string, file: string, analysis: FileAnalysis | null, fn: FunctionSpan | undefined): { comments: ReasonComment[]; unread?: string } {
  if (!analysis) return { comments: [], unread: "no per-file analysis" };
  if (analysis.generated || analysis.vendoredLibrary) return { comments: [], unread: "generated or vendored file" };
  const spec = manifestFor(analysis.language)?.docComments;
  if (!spec) return { comments: [], unread: `no comment syntax declared for ${analysis.language}` };
  const all = findReasonComments(source, file, spec, spansOf(analysis));
  return { comments: fn ? all.filter((c) => (c.anchor?.name === fn.name && c.anchor.line === fn.line) || (c.line >= fn.line && c.endLine <= fn.endLine)) : all };
}

/** Rows ranked by how many of `terms` they mention (ties keep their order); unchanged without terms. */
function rank<T>(rows: readonly T[], terms: readonly string[], text: (row: T) => string): T[] {
  if (!terms.length) return [...rows];
  const score = (row: T) => {
    const t = text(row).toLowerCase();
    return terms.filter((term) => t.includes(term)).length;
  };
  return rows.map((row) => ({ row, s: score(row) })).sort((a, b) => b.s - a.s).map((x) => x.row);
}

function topRows<T>(rows: readonly T[], limit: number, render: (row: T) => string): string[] {
  return [...rows.slice(0, limit).map((r) => `- ${render(r)}`), ...(rows.length > limit ? [`  … ${rows.length - limit} more`] : [])];
}

const commentRow = (c: ReasonComment) =>
  `${c.file}:${c.line}${c.endLine > c.line ? `-${c.endLine}` : ""}${c.anchor ? ` ${c.anchor.where} ${c.anchor.name}()` : ""} — "${c.text}"`;

const commitRow = (c: CommitReason) => `${c.sha} ${c.date} ${c.subject} — "${c.excerpt}"`;

/** What the commit lane read, for a lane with nothing to show. */
function commitsLooked(c: CommitReasons, fn?: FunctionSpan): string {
  if (c.status === "no-git") return "no git history here";
  if (c.status === "failed") return "git log failed or timed out";
  const what = c.scope === "lines" && fn ? `touching lines ${fn.line}-${fn.endLine}` : "of the file";
  const read = !c.scanned ? "git holds no commit of the file (not tracked here)" : c.scanned === 1 ? `the one commit ${what} states no reason in its body` : `none of the ${c.scanned} commits ${what} states a reason in its body`;
  return `${read}${c.shallow ? " (shallow clone: older history is not here)" : ""}`;
}
