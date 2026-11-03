import { readFile } from "fs/promises";
import { join } from "path";
import type { McpTool } from "../protocol.js";
import type { FileAnalysis, SymbolLink } from "../../types/analysis.js";
import { symbolKey } from "../store.js";
import { confidenceNote, fenced, joinLines, loc, numberArg, plural, requiredStringArg, stringArg } from "../format.js";
import { isTestPath, mustResolveFile, nearSymbols, requireAnalysis, stalenessHint, type ToolContext } from "./context.js";
import { bestNamed } from "../search-rank.js";
import { noResults } from "../empty.js";
import { packageApiText } from "../package-api.js";
import { declarationHeadLine } from "../../core/doc-comments.js";
import { pluginFor } from "../../extractors/registry.js";

/** Rough tokens per character of source — the usual 4-characters-per-token rule. */
const CHARS_PER_TOKEN = 4;
/** Definitions of one name listed when it is ambiguous. */
const MAX_CANDIDATES = 12;
/** Callees withheld from the budget, listed by location. */
const MAX_WITHHELD = 25;

/** One function or method body to print: where it is and how it was reached. */
interface Span {
  file: string;
  symbol: string;
  line: number;
  endLine: number;
  depth: number;
  /** The call that reached it (absent for the seed). */
  via?: SymbolLink;
  /** What the definition's head above `line` holds: its decorators and the first words of its doc comment. */
  head?: Head;
}

/** The definition's own decorators and doc, which say how far above `line` its head starts. */
interface Head {
  decorators?: readonly string[];
  doc?: string;
  language?: FileAnalysis["language"];
}

/** A definition the per-file analysis holds: its span and its head. */
interface Definition {
  symbol: string;
  line: number;
  endLine: number;
  head: Head;
}

/**
 * `clarifydoc_extract`: a function's source and the source of what it calls,
 * cut at a token budget — the context an agent needs to change one function,
 * without reading whole files. Spans come from the per-file analysis (every
 * overload of the name), callees from the resolved call graph breadth-first;
 * what does not fit is listed by location with its size, so the agent can ask
 * for it. Read-only: source is read from disk at the analyzed spans, and a file
 * whose length changed since the analysis is flagged.
 */
export function extractTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_extract",
    title: "Source of a function and what it calls",
    description: "Use for what one function does: its source, decorators and doc included, and its callees' within `maxTokens`. `depth` 0-3; `package`: an installed package's API (`symbol`: one export).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "`Class.method` or a name." },
        file: { type: "string", description: "When the name is not unique." },
        depth: { type: "number" },
        maxTokens: { type: "number" },
        package: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const pkg = stringArg(args, "package");
      if (pkg) return { text: await packageApiText(loaded, ctx.store.projectRoot, pkg.trim(), stringArg(args, "symbol")) };
      const symbol = requiredStringArg(args, "symbol");
      const fileArg = stringArg(args, "file");
      const depth = numberArg(args, "depth", 1, { min: 0, max: 3 });
      const maxTokens = numberArg(args, "maxTokens", 6000, { min: 200, max: 30000 });
      const file = fileArg ? mustResolveFile(loaded, fileArg) : undefined;
      const links = loaded.summary.symbolLinks ?? [];

      // Files that may define it: the one named, else every file a link
      // places a symbol of that name in.
      const want = symbol.toLowerCase();
      const named = (s: string) => s.toLowerCase() === want || s.toLowerCase().endsWith(`.${want}`);
      const files = new Set<string>();
      if (file) files.add(file);
      else {
        for (const l of links) {
          if (named(l.targetSymbol)) files.add(l.targetFile);
          if (named(l.sourceSymbol)) files.add(l.sourceFile);
        }
        // A definition nothing links to: a function by its complexity row, a class by its node.
        for (const c of loaded.summary.complexity ?? []) if (c.functions.some((f) => named(f.functionName))) files.add(c.filePath);
        for (const n of loaded.summary.classGraph?.nodes ?? []) if (!n.isFile && !n.isExternal && named(n.name)) files.add(n.filePath);
      }
      const analyses = new Map<string, FileAnalysis | null>();
      const analysisOf = async (f: string) => {
        if (!analyses.has(f)) analyses.set(f, await ctx.store.fileAnalysis(f));
        return analyses.get(f) ?? null;
      };
      // A class is a definition the name can mean too (`Car`), though never a callee's span.
      const matched: Span[] = [];
      for (const f of [...files].sort()) {
        const a = await analysisOf(f);
        for (const def of [...definitions(a), ...classDefinitions(a)]) if (named(def.symbol)) matched.push({ file: f, ...def, depth: 0 });
      }
      // The definition the name names: the exact spelling first, production code before tests.
      const seeds = bestNamed(symbol, matched, (s) => s.symbol, (s) => isTestPath(loaded.summary, s.file));
      const definedIn = new Set(seeds.map((s) => `${s.file}::${s.symbol}`));
      if (seeds.length === 0) {
        const near = nearSymbols(loaded.summary, symbol);
        return {
          text: noResults({
            headline: `No function or method named \`${symbol}\`${file ? ` in ${file}` : ""} in the analysis.`,
            holds: [file ? "The file's analysis lists no definition of that name." : "No resolved call reaches or leaves a symbol of that name.", near?.line],
            next: [
              !!near && `clarifydoc_extract symbol="${near.first.name}" file="${near.first.file}"`,
              `clarifydoc_search query="${symbol}" kinds=["symbol"] — check the spelling`,
              !file && `clarifydoc_extract symbol="${symbol}" file="<the file that defines it>"`,
              await stalenessHint(ctx.store),
            ],
          }),
        };
      }
      if (definedIn.size > 1 && !file) {
        const candidates = [...definedIn].slice(0, MAX_CANDIDATES).map((k) => {
          const [f, s] = k.split("::") as [string, string];
          const span = seeds.find((x) => x.file === f && x.symbol === s)!;
          return `- ${s}() ${loc(f, span.line)} → clarifydoc_extract symbol="${s}" file="${f}"`;
        });
        return {
          text: joinLines([
            `# \`${symbol}\` is defined in ${plural(definedIn.size, "place")} — pick one`,
            ...candidates,
            definedIn.size > MAX_CANDIDATES ? `  … ${definedIn.size - MAX_CANDIDATES} more (pass \`file\`)` : "",
          ]),
        };
      }

      // Callees, breadth-first, function/method spans only (a class's body is
      // not "what it calls"). Every overload of a name the call can mean is included.
      const bySource = new Map<string, SymbolLink[]>();
      for (const l of links) {
        if (l.relation && l.relation !== "calls" && l.relation !== "passes") continue;
        const k = symbolKey(l.sourceFile, l.sourceSymbol);
        const list = bySource.get(k);
        if (list) list.push(l);
        else bySource.set(k, [l]);
      }
      const spans: Span[] = [...seeds];
      const seen = new Set(seeds.map((s) => symbolKey(s.file, s.symbol)));
      let frontier = seeds;
      for (let d = 1; d <= depth; d++) {
        const next: Span[] = [];
        for (const node of frontier) {
          for (const l of bySource.get(symbolKey(node.file, node.symbol)) ?? []) {
            const k = symbolKey(l.targetFile, l.targetSymbol);
            if (seen.has(k)) continue;
            seen.add(k);
            const a = await analysisOf(l.targetFile);
            const defs = definitions(a).filter((x) => x.symbol === l.targetSymbol);
            // The overload the linker picked, when it did; else every one.
            const picked = defs.filter((x) => x.line === l.targetLine);
            for (const def of picked.length ? picked : defs) next.push({ file: l.targetFile, ...def, depth: d, via: l });
          }
        }
        spans.push(...next);
        frontier = next;
      }

      // Read the bodies and spend the budget in walk order; the seed always prints.
      const sources = new Map<string, string[] | null>();
      const linesOf = async (f: string): Promise<string[] | null> => {
        if (!sources.has(f)) {
          try {
            sources.set(f, (await readFile(join(ctx.store.projectRoot, f), "utf-8")).split(/\r?\n/));
          } catch {
            sources.set(f, null);
          }
        }
        return sources.get(f) ?? null;
      };
      const blocks: string[] = [];
      const withheld: Array<{ span: Span; tokens: number }> = [];
      const stale = new Set<string>();
      let used = 0;
      for (const span of spans) {
        const lines = await linesOf(span.file);
        if (!lines) continue;
        const lineCount = analyses.get(span.file)?.lineCount;
        if (lineCount !== undefined && Math.abs(lineCount - lines.length) > 1) stale.add(span.file);
        // The decorators, attributes and doc comment above the definition are part of what it says.
        const from = span.head ? declarationHeadLine(lines, span.line, span.head.language ? pluginFor(span.head.language)?.docComments : undefined, span.head) : span.line;
        const body = lines.slice(from - 1, span.endLine).join("\n");
        const tokens = Math.ceil(body.length / CHARS_PER_TOKEN);
        if (span.depth > 0 && used + tokens > maxTokens) {
          withheld.push({ span, tokens });
          continue;
        }
        used += tokens;
        const how = span.via
          ? ` — called as ${span.via.callName} at ${loc(span.via.sourceFile, span.via.sourceLine)}${confidenceNote(span.via.confidence, span.via.resolvedBy, span.via.strategy)}`
          : "";
        blocks.push(
          `## ${span.symbol}() — ${span.file}:${from}-${span.endLine}${span.depth ? ` (hop ${span.depth})` : ""}${how}`,
          fenced(span.depth === 0 && tokens > maxTokens ? `${body.slice(0, maxTokens * CHARS_PER_TOKEN)}\n… (cut at the budget)` : body),
          "",
        );
      }

      const callees = spans.length - seeds.length;
      return {
        text: joinLines([
          `# ${symbol} — ${plural(seeds.length, "definition")}${depth ? `, ${plural(callees, "callee")} within ${plural(depth, "hop")}` : ""} · ≈${used} tokens`,
          stale.size ? `(changed since the analysis — lines may be off: ${[...stale].join(", ")})` : "",
          "",
          ...blocks,
          withheld.length ? `## Withheld — over the ${maxTokens}-token budget (${withheld.length})` : "",
          ...withheld.slice(0, MAX_WITHHELD).map(({ span, tokens }) =>
            `- ${span.symbol}() ${span.file}:${span.line}-${span.endLine} ≈${tokens} tokens (hop ${span.depth})`),
          withheld.length > MAX_WITHHELD ? `  … ${withheld.length - MAX_WITHHELD} more` : "",
          withheld.length ? "Raise `maxTokens`, or extract one of them by name." : "",
        ]),
      };
    },
  };
}

/** The head of a function, method or class: what `declarationHeadLine` reads above it. */
function headOf(a: FileAnalysis, item: { decorators?: readonly string[]; doc?: string }): Head {
  return { language: a.language, ...(item.decorators?.length ? { decorators: item.decorators } : {}), ...(item.doc ? { doc: item.doc } : {}) };
}

/** Every class a file defines, by name — a definition a name can mean, though never a callee's span. */
function classDefinitions(a: FileAnalysis | null): Definition[] {
  if (!a) return [];
  return (a.classes ?? []).filter((c) => c.line > 0 && c.endLine >= c.line).map((c) => ({ symbol: c.name, line: c.line, endLine: c.endLine, head: headOf(a, c) }));
}

/** Every function and method a file defines, keyed the way symbol links name them (`Class.method`). */
function definitions(a: FileAnalysis | null): Definition[] {
  if (!a) return [];
  const out: Definition[] = [];
  for (const fn of a.functions ?? []) out.push({ symbol: fn.name, line: fn.line, endLine: fn.endLine, head: headOf(a, fn) });
  for (const cls of a.classes ?? []) {
    for (const m of cls.methods ?? []) out.push({ symbol: `${cls.name}.${m.name}`, line: m.line, endLine: m.endLine, head: headOf(a, m) });
  }
  return out;
}
