import { join } from "path";
import type { FileAnalysis, Language, PatternInfo, SymbolDataAccess, SymbolLink } from "../types/analysis.js";
import { manifestFor } from "../extractors/registry.js";
import { controlFlowForFile } from "./control-flow-file.js";

/**
 * Database work inside a loop — the N+1 shape: a query per item where one
 * query for all of them would do. Found where the control-flow graph puts a
 * database call site (`SymbolDataAccess.sites`) inside a loop's body, or a
 * call inside the body to a project function that queries itself (one hop,
 * through the symbol links). A query in the loop's own header runs once and
 * is not one. Languages with no control-flow graph are not judged.
 */
export async function findQueriesInLoops(input: {
  projectRoot: string;
  dataAccess: readonly SymbolDataAccess[];
  symbolLinks: readonly SymbolLink[];
  /** Files not to judge (tests, generated). */
  skip: (file: string) => boolean;
  /** Bound on the files read (a control-flow graph is built per file). */
  maxFiles?: number;
}): Promise<PatternInfo[]> {
  const dbFns = new Map<string, SymbolDataAccess>();
  const sitesByFile = new Map<string, Array<{ line: number; via?: string; entity: string }>>();
  const add = (file: string, s: { line: number; via?: string; entity: string }) => {
    if (input.skip(file)) return;
    (sitesByFile.get(file) ?? sitesByFile.set(file, []).get(file)!).push(s);
  };
  for (const d of input.dataAccess) {
    if (d.access) continue; // queue publish/consume is not the N+1 concern
    dbFns.set(`${d.file}\u0000${d.symbol}`, d);
    for (const site of d.sites ?? []) add(d.file, { line: site.line, entity: d.entity });
  }
  // A call to a function that queries counts as a query at the call.
  for (const l of input.symbolLinks) {
    if (l.navigational || l.relation === "reference") continue;
    const target = dbFns.get(`${l.targetFile}\u0000${l.targetSymbol}`);
    if (target && !(l.sourceFile === l.targetFile && l.sourceSymbol === l.targetSymbol)) add(l.sourceFile, { line: l.sourceLine, via: l.targetSymbol, entity: target.entity });
  }

  const out: PatternInfo[] = [];
  const files = [...sitesByFile.keys()].sort().slice(0, input.maxFiles ?? 2000);
  for (const file of files) {
    let cfgs;
    try {
      cfgs = (await controlFlowForFile({ filePath: join(input.projectRoot, file), displayPath: file })).cfgs;
    } catch {
      continue; // no graph for this language
    }
    const seen = new Set<number>();
    for (const cfg of cfgs) {
      const loops = cfg.nodes.filter((n) => n.kind === "LOOP" && n.line !== undefined && n.endLine !== undefined);
      if (!loops.length) continue;
      for (const site of sitesByFile.get(file)!) {
        if (site.line < cfg.line || site.line > cfg.endLine || seen.has(site.line)) continue;
        const loop = loops.find((l) => site.line > l.line! && site.line <= l.endLine!);
        if (!loop) continue;
        seen.add(site.line);
        out.push({
          kind: "query-in-loop",
          name: cfg.functionName,
          filePath: file,
          line: site.line,
          confidence: site.via ? "medium" : "high",
          detail: site.via
            ? `calls ${site.via}, which queries ${site.entity}, once per pass of the loop at line ${loop.line} — one query for all items would do`
            : `queries ${site.entity} once per pass of the loop at line ${loop.line} — one query for all items would do`,
        });
      }
    }
  }
  return out;
}

/**
 * A blocking call inside an async function: the event loop (Node) or the
 * running coroutine's loop (asyncio) stalls for every caller while it runs.
 * Which calls block is the language's to say (`blockingCalls` on its plugin
 * manifest: `readFileSync`, `time.sleep`, `requests.get`, …), matched against
 * the call as the extractor spells it (`fs.readFileSync`, `time.sleep`).
 */
export function findBlockingInAsync(analyses: readonly FileAnalysis[], skip: (file: string) => boolean): PatternInfo[] {
  const out: PatternInfo[] = [];
  for (const a of analyses) {
    const blocking = manifestFor(a.language as Language)?.blockingCalls;
    if (!blocking || skip(a.filePath)) continue;
    const fns = [...a.functions, ...a.classes.flatMap((c) => (c.methods ?? []).map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
    for (const fn of fns) {
      if (!fn.isAsync) continue;
      const seen = new Set<string>();
      for (const call of fn.calls ?? []) {
        const name = call.name;
        if (!blocking.test(name) || seen.has(name)) continue;
        seen.add(name);
        out.push({
          kind: "blocking-in-async",
          name: fn.name,
          filePath: a.filePath,
          line: call.line ?? fn.line,
          confidence: "medium",
          detail: `${name}() blocks inside async ${fn.name} — every other request waits while it runs; use the asynchronous form`,
        });
      }
    }
  }
  return out;
}
