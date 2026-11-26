import { readFile } from "fs/promises";
import { join } from "path";
import type { ClassInfo, EntityGraph, FileAnalysis, FunctionInfo, Language, PatternInfo, SymbolDataAccess, SymbolLink } from "../types/analysis.js";
import { manifestFor } from "../extractors/registry.js";
import type { LanguagePluginMeta } from "../types/language-plugin.js";
import { controlFlowForFile } from "./control-flow-file.js";

/**
 * Database work inside a loop — the N+1 shape: a query per item where one
 * query for all of them would do. Found where the control-flow graph puts a
 * database call site (`SymbolDataAccess.sites`) inside a loop's body, or a
 * call inside the body to a project function that queries itself (one hop,
 * through the symbol links). A query in the loop's own header runs once and
 * is not one. Languages with no control-flow graph are not judged.
 *
 * `blocking-in-async` is the sibling pattern, read from each manifest's `blockingCalls`; a manifest's
 * `blockingOnReceiver` flags `x.Wait()` / `x.Result` in an async method only when `x`'s declared type is that
 * type, never a project class's member. Both are ordered widest reach first by `rankPerformanceByReach`.
 */
export async function findQueriesInLoops(input: {
  projectRoot: string;
  dataAccess: readonly SymbolDataAccess[];
  symbolLinks: readonly SymbolLink[];
  /** Files not to judge (tests, generated). */
  skip: (file: string) => boolean;
  /** Bound on the files read (a control-flow graph is built per file). */
  maxFiles?: number;
  /** The ER model: a loop over one entity's rows that queries a related one names the relation. */
  entityGraph?: Pick<EntityGraph, "nodes" | "edges">;
  /**
   * Where the files' loops come from, one answer per file in order (null or undefined: not judged) — worker
   * threads, or a cache an incremental run keeps by content hash; default `loopShapes`, one file at a time.
   */
  shapesOf?: (files: readonly string[]) => Promise<Array<LoopShape[] | null | undefined>>;
}): Promise<PatternInfo[]> {
  const dbFns = new Map<string, SymbolDataAccess>();
  const sitesByFile = new Map<string, Array<{ line: number; via?: string; entity: string }>>();
  const add = (file: string, s: { line: number; via?: string; entity: string }) => {
    if (input.skip(file)) return;
    (sitesByFile.get(file) ?? sitesByFile.set(file, []).get(file)!).push(s);
  };
  // Every direct database call site by line: what a loop header, or a value it iterates, reads.
  const queryAt = new Map<string, Map<number, string>>();
  for (const d of input.dataAccess) {
    if (d.access) continue; // queue publish/consume is not the N+1 concern
    dbFns.set(`${d.file}\u0000${d.symbol}`, d);
    for (const site of d.sites ?? []) {
      add(d.file, { line: site.line, entity: d.entity });
      (queryAt.get(d.file) ?? queryAt.set(d.file, new Map()).get(d.file)!).set(site.line, d.entity);
    }
  }
  const related = relationsOf(input.entityGraph);
  // A call to a function that queries counts as a query at the call.
  for (const l of input.symbolLinks) {
    if (l.navigational || l.relation === "reference") continue;
    const target = dbFns.get(`${l.targetFile}\u0000${l.targetSymbol}`);
    if (target && !(l.sourceFile === l.targetFile && l.sourceSymbol === l.targetSymbol)) add(l.sourceFile, { line: l.sourceLine, via: l.targetSymbol, entity: target.entity });
  }

  const out: PatternInfo[] = [];
  const files = [...sitesByFile.keys()].sort().slice(0, input.maxFiles ?? 2000);
  let shapes: Array<LoopShape[] | null | undefined>;
  if (input.shapesOf) {
    shapes = await input.shapesOf(files);
  } else {
    shapes = [];
    for (const file of files) shapes.push(await loopShapes(input.projectRoot, file));
  }
  for (let at = 0; at < files.length; at++) {
    const file = files[at]!;
    const cfgs = shapes[at];
    if (!cfgs) continue; // no graph for this language
    const seen = new Set<number>();
    let lines: string[] | undefined;
    for (const cfg of cfgs) {
      const loops = cfg.loops;
      if (!loops.length) continue;
      for (const site of sitesByFile.get(file)!) {
        if (site.line < cfg.line || site.line > cfg.endLine || seen.has(site.line)) continue;
        // The innermost loop holding the call: the one whose passes it multiplies.
        const loop = loops
          .filter((l) => site.line > l.line! && site.line <= l.endLine!)
          .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
        if (!loop) continue;
        seen.add(site.line);
        lines ??= await readFile(join(input.projectRoot, file), "utf8").then((t) => t.split("\n"), () => []);
        const size = loopSize(loop.label, loop.line!, cfg.line, queryAt.get(file), lines);
        const what = site.via ? `calls ${site.via}, which queries ${site.entity},` : `queries ${site.entity}`;
        const relation = size.iterates ? related(size.iterates, site.entity) : undefined;
        const detail = size.iterates
          ? `${what} once for each ${size.iterates} row the loop at line ${loop.line} walks — ${relation ? `the ${relation} relation loads them in one query (a join or eager load)` : "one query for all of them would do"}`
          : size.bound !== undefined
            ? `${what} once per pass of the loop at line ${loop.line}, which runs at most ${size.bound} times — a fixed cost, not one that grows with the data`
            : `${what} once per pass of the loop at line ${loop.line} — one query for all items would do`;
        out.push({
          kind: "query-in-loop",
          name: cfg.functionName,
          filePath: file,
          line: site.line,
          // Over query rows it grows with the table: the surest N+1. A small fixed loop is barely one.
          confidence: size.bound !== undefined ? "low" : site.via ? "medium" : "high",
          detail,
          ...(size.iterates || size.bound !== undefined ? { loop: { ...(size.iterates ? { iterates: size.iterates } : {}), ...(size.bound !== undefined ? { bound: size.bound } : {}), ...(relation ? { relation } : {}) } } : {}),
        });
      }
    }
  }
  return out;
}

/** One function's span and the loops its control-flow graph holds — all `findQueriesInLoops` reads of the graph. */
export interface LoopShape {
  functionName: string;
  line: number;
  endLine: number;
  loops: Array<{ line: number; endLine: number; label: string }>;
}

/**
 * The loop-holding functions of a file, in source order, from its control-flow
 * graphs; null when its language has none. A pure function of the file's text,
 * so a caller may keep it by content hash.
 */
export async function loopShapes(projectRoot: string, file: string): Promise<LoopShape[] | null> {
  let cfgs;
  try {
    cfgs = (await controlFlowForFile({ filePath: join(projectRoot, file), displayPath: file })).cfgs;
  } catch {
    return null;
  }
  const out: LoopShape[] = [];
  for (const cfg of cfgs) {
    const loops = cfg.nodes
      .filter((n) => n.kind === "LOOP" && n.line !== undefined && n.endLine !== undefined)
      .map((n) => ({ line: n.line!, endLine: n.endLine!, label: n.label }));
    if (loops.length) out.push({ functionName: cfg.functionName, line: cfg.line, endLine: cfg.endLine, loops });
  }
  return out;
}

/** Loops this short are a fixed cost: a query per pass is a handful, not N. */
const SMALL_LOOP = 10;

/**
 * What a loop walks, read off its header (the control-flow node's label) and
 * the function's own lines: the rows of a query — the header runs the query
 * itself, or names a variable an earlier line of the function assigned from
 * one — or a small fixed number of passes: a literal list of at most ten
 * items, or a bound of at most ten (`range(3)`, `i < 5`, `0..3`, `times`).
 * The header's own spelling is all it reads, so it says nothing it cannot see.
 */
export function loopSize(
  header: string,
  headerLine: number,
  functionLine: number,
  queries: ReadonlyMap<number, string> | undefined,
  lines: readonly string[],
): { iterates?: string; bound?: number } {
  // The header runs a query: its rows are what the loop walks.
  const own = queries?.get(headerLine);
  if (own) return { iterates: own };
  // A variable the header names, assigned from a query earlier in the function.
  if (queries) {
    const names = new Set(header.match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (let l = headerLine - 1; l >= functionLine; l--) {
      const entity = queries.get(l);
      if (!entity) continue;
      const assigned = /^\s*(?:(?:const|let|var|val|my|final|auto)\s+)?\$?([A-Za-z_][\w]*)\s*(?::[^=]*)?(?::=|=|<-)(?!=)/.exec(lines[l - 1] ?? "")?.[1];
      if (assigned && names.has(assigned)) return { iterates: entity };
    }
  }
  // A literal list of a few items: `for (const k of ["a", "b"])`, `for x in (1, 2, 3)`.
  const item = String.raw`(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)`;
  const list = new RegExp(String.raw`(?:\bof|\bin|\bforeach|\beach)\s*[([](\s*${item}\s*(?:,\s*${item}\s*)*(?:,\s*)?)[)\]]`).exec(header);
  if (list) {
    const n = list[1]!.split(",").filter((x) => x.trim()).length;
    if (n <= SMALL_LOOP) return { bound: n };
  }
  // A small numeric bound: `range(3)`, `i < 5`, `i <= 4`, `0..3`, `3.times`.
  const numbers = [
    /\brange\(\s*(?:\d+\s*,\s*)?(\d+)\s*\)/.exec(header)?.[1],
    /<\s*=?\s*(\d+)\s*;/.exec(header)?.[1],
    /\d+\s*\.\.=?\s*(\d+)/.exec(header)?.[1],
    /\b(\d+)\s*\.\s*times\b/.exec(header)?.[1],
  ].filter((x): x is string => x !== undefined).map(Number);
  if (numbers.length && Math.max(...numbers) <= SMALL_LOOP) return { bound: Math.max(...numbers) };
  return {};
}

/** "Order→Customer" when the ER model relates the two (either way), by entity name. */
function relationsOf(graph: Pick<EntityGraph, "nodes" | "edges"> | undefined): (a: string, b: string) => string | undefined {
  if (!graph) return () => undefined;
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const pairs = new Map<string, string>();
  for (const e of graph.edges) {
    const a = nameOf.get(e.source);
    const b = nameOf.get(e.target);
    if (!a || !b || a === b) continue;
    const field = e.fields[0];
    pairs.set(`${a}\u0000${b}`, `${a}→${b}${field ? ` (${a}.${field})` : ""}`);
    pairs.set(`${b}\u0000${a}`, `${b}→${a}`);
  }
  return (a, b) => pairs.get(`${a}\u0000${b}`);
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
  let classes: Map<string, ClassInfo[]> | undefined;
  const classesIn = (language: string, name: string): ClassInfo[] => {
    if (!classes) {
      classes = new Map();
      for (const a of analyses) for (const c of a.classes) (classes.get(`${a.language}\0${c.name}`) ?? classes.set(`${a.language}\0${c.name}`, []).get(`${a.language}\0${c.name}`)!).push(c);
    }
    return classes.get(`${language}\0${name}`) ?? [];
  };
  for (const a of analyses) {
    const manifest = manifestFor(a.language as Language);
    const blocking = manifest?.blockingCalls;
    const typed = manifest?.blockingOnReceiver;
    if ((!blocking && !typed) || skip(a.filePath)) continue;
    const classesNamed = (name: string): ClassInfo[] => classesIn(a.language, name);
    const typedApplies = typed ? !typed.types.some((t) => classesNamed(t).length > 0) : false;
    const fns: Array<{ fn: FunctionInfo; name: string; owner?: ClassInfo }> = [
      ...a.functions.map((fn) => ({ fn, name: fn.name })),
      ...a.classes.flatMap((c) => (c.methods ?? []).map((fn) => ({ fn, name: `${c.name}.${fn.name}`, owner: c }))),
    ];
    for (const { fn, name: fnName, owner } of fns) {
      if (!fn.isAsync) continue;
      const seen = new Set<string>();
      for (const call of fn.calls ?? []) {
        const name = call.name;
        if (seen.has(name)) continue;
        const flagged = (blocking?.test(name) ?? false) || (typedApplies && typed !== undefined && blocksOnReceiver(name, typed, fn, owner, classesNamed));
        if (!flagged) continue;
        seen.add(name);
        out.push({
          kind: "blocking-in-async",
          name: fnName,
          filePath: a.filePath,
          line: call.line ?? fn.line,
          confidence: "medium",
          detail: `${name}() blocks inside async ${fnName} — every other request waits while it runs; use the asynchronous form`,
        });
      }
      // A property read that blocks (`task.Result`): no call states it, the plugin states the read.
      if (typedApplies && typed?.readMembers && fn.propertyReads) {
        const reads = { ...typed, members: typed.readMembers };
        for (const read of fn.propertyReads) {
          if (seen.has(read.name) || !blocksOnReceiver(read.name, reads, fn, owner, classesNamed)) continue;
          seen.add(read.name);
          out.push({
            kind: "blocking-in-async",
            name: fnName,
            filePath: a.filePath,
            line: read.line,
            confidence: "medium",
            detail: `${read.name} (a property read) blocks inside async ${fnName} — every other request waits while it runs; await the task instead`,
          });
        }
      }
    }
  }
  return out;
}

/** `receiver.member` where `member` blocks and the receiver's declared type is one the language says it blocks on. */
function blocksOnReceiver(
  call: string,
  spec: NonNullable<LanguagePluginMeta["blockingOnReceiver"]>,
  fn: FunctionInfo,
  owner: ClassInfo | undefined,
  classesNamed: (name: string) => ClassInfo[],
): boolean {
  // A call chain's result (`repo.FindAsync().Result`): the declared return of that call, through a class the project declares once.
  const chained = /^(.+\(\))\.(\w+)$/.exec(call);
  if (chained) {
    if (!spec.members.test(chained[2]!)) return false;
    const declared = declaredResult(chained[1]!, fn, owner, classesNamed);
    return !!declared && spec.receiverTypes.test(declared);
  }
  const m = /^(this\.)?([A-Za-z_]\w*)\.(\w+)$/.exec(call);
  if (!m || !spec.members.test(m[3]!)) return false;
  const head = m[2]!;
  // `this.task` is the caller's field, never a local of that name.
  if (m[1]) {
    const field = owner?.properties?.find((p) => p.name === head)?.type;
    return !!field && spec.receiverTypes.test(field.trim());
  }
  const types = new Set<string>();
  let unknown = false;
  const entries = (fn.localTypes ?? []).filter((l) => l.name === head);
  for (const l of entries) {
    if (l.type) types.add(l.type.trim());
    else if (l.from && !l.awaited && !l.element && l.fromIndex === undefined && !l.destructured && !l.member && !l.aliasOf) {
      const declared = declaredResult(l.from, fn, owner, classesNamed);
      if (declared) types.add(declared);
      else unknown = true;
    } else unknown = true;
  }
  if (entries.length === 0) {
    const param = fn.params?.find((p) => p.name === head);
    const field = owner?.properties?.find((p) => p.name === head);
    const written = param ? param.type : field?.type;
    if (written) types.add(written.trim());
    else unknown = true;
  }
  return !unknown && types.size === 1 && spec.receiverTypes.test([...types][0]!);
}

/** The declared return of the call a local was initialized from: `own()`, `field.method()` or `param.method()`, through a class the project declares once. */
function declaredResult(from: string, fn: FunctionInfo, owner: ClassInfo | undefined, classesNamed: (name: string) => ClassInfo[]): string | null {
  const m = /^(?:this\.)?(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\(\)$/.exec(from);
  if (!m) return null;
  let cls: ClassInfo | undefined;
  if (m[1]) {
    const written = fn.params?.find((p) => p.name === m[1])?.type ?? owner?.properties?.find((p) => p.name === m[1])?.type;
    if (!written || (fn.localTypes ?? []).some((l) => l.name === m[1])) return null;
    const holders = classesNamed(written.trim());
    cls = holders.length === 1 ? holders[0] : undefined;
  } else cls = owner;
  const returns = new Set((cls?.methods ?? []).filter((x) => x.name === m[2]).map((x) => x.returnType?.trim() ?? ""));
  return returns.size === 1 && [...returns][0] ? [...returns][0]! : null;
}
