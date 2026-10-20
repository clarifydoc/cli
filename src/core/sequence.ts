import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";
import { idFactory, mermaidLabel } from "./mermaid-text.js";
import { trimTrailingSlashes } from "../extractors/plugins/shared/path-utils.js";
import type { SequenceFrame } from "./sequence-frames.js";

/**
 * What an endpoint does, in order, as a Mermaid `sequenceDiagram`: the
 * route's handler, then every call it makes depth-first in source order,
 * each answered by a return once its own calls are drawn; the tables it
 * reads and writes, the queues it publishes to, and the HTTP calls it makes
 * to another tier — the linker's `http` edges, into the handler that serves
 * them. Lanes are classes
 * (`OrderService.create` → OrderService), else files.
 *
 * On demand, like `cfg`: computed from a written analysis, never stored.
 * Bounds: a visited set per path (a recursion is marked, not followed),
 * `depth` hops (default 8), and `fanOut` calls per caller (default 12) with
 * "+N more". A call the linker only guessed (AMBIGUOUS) is drawn as an
 * open-headed arrow, so it reads as uncertain. With `frames` (each walked
 * function's loops and branches, `sequence-frames.ts`), a call made inside a
 * loop or a branch is drawn inside a `loop` / `alt` / `opt` frame.
 */

export interface SequenceOptions {
  depth?: number;
  fanOut?: number;
  /** Loops and branches per file (`sequenceFrames`). */
  frames?: ReadonlyMap<string, readonly SequenceFrame[]>;
  /**
   * `class` (the default): a lane per class, else per file. `package`: a lane
   * per directory, so a long flow reads at the level of its modules; the
   * directories in `expand` (and below them) keep their class lanes.
   */
  lanes?: "class" | "package";
  expand?: readonly string[];
}

type Row = ProjectAnalysis["routeMap"][number];

/**
 * The call-graph anchor of a route: the linker names it by the path its own
 * file declares (`route:GET /:id`), which a mount later prefixes
 * (`/api/users/:id`). The anchor in the route's file with its method whose
 * path the composed one ends with — exact first, then the longest.
 */
export function routeAnchor(r: Pick<Row, "httpMethod" | "path" | "filePath">, links: readonly SymbolLink[]): string | null {
  const prefix = `route:${(r.httpMethod ?? "USE").toUpperCase()} `;
  const paths = [...new Set(links.filter((l) => l.sourceFile === r.filePath && l.sourceSymbol.startsWith(prefix)).map((l) => l.sourceSymbol.slice(prefix.length)))];
  if (paths.includes(r.path)) return prefix + r.path;
  const suffix = paths.filter((p) => p !== "/" && r.path.endsWith(p)).sort((a, b) => b.length - a.length)[0];
  if (suffix) return prefix + suffix;
  return paths.includes("/") ? `${prefix}/` : null;
}

/** The routes a subject names: `GET /x` by method and path, exact first, then normalized, then a substring. */
export function findRoutes(routes: readonly Row[], subject: string, file?: string): Row[] {
  const verb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(subject)?.[1]?.toUpperCase();
  const path = subject.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "").trim();
  const pool = routes.filter((r) => (!verb || (r.httpMethod ?? "").toUpperCase() === verb) && (!file || (r.filePath ?? "").includes(file)));
  const exact = pool.filter((r) => r.path === path);
  if (exact.length) return exact;
  const norm = (p: string) => trimTrailingSlashes(p.replace(/\{[^{}]+\}|:[\w]+/g, "{}")).toLowerCase();
  const same = pool.filter((r) => norm(r.path) === norm(path));
  return same.length ? same : pool.filter((r) => r.path.toLowerCase().includes(path.toLowerCase()));
}

const classLane = (file: string, symbol: string): string => {
  if (symbol.startsWith("route:")) return file.split("/").pop()!;
  const dot = symbol.lastIndexOf(".");
  return dot > 0 ? symbol.slice(0, dot) : file.split("/").pop()!;
};

/** The lane a call lands in, by the options' lane level. */
function laneRule(opts: SequenceOptions): (file: string, symbol: string) => string {
  if (opts.lanes !== "package") return classLane;
  const expand = (opts.expand ?? []).map((d) => d.replace(/^\.\/|\/+$/g, "")).filter(Boolean);
  return (file, symbol) => {
    if (expand.some((d) => file === d || file.startsWith(`${d}/`))) return classLane(file, symbol);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    return `${dir}/`;
  };
}

const short = (symbol: string): string => {
  if (symbol.startsWith("route:")) return symbol.slice("route:".length);
  const dot = symbol.lastIndexOf(".");
  return `${dot > 0 ? symbol.slice(dot + 1) : symbol}()`;
};

/** A sequence diagram from a seed symbol (`route:GET /x` in its file, or `Class.method`). */
export function buildSequence(summary: ProjectAnalysis, seed: { file: string; symbol: string; title: string }, opts: SequenceOptions = {}): string {
  const depth = opts.depth ?? 8;
  const laneOf = laneRule(opts);
  const fanOut = opts.fanOut ?? 12;
  const calls = new Map<string, SymbolLink[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.relation === "reference" || l.sourceSymbol === "(reference)" || l.navigational) continue;
    const k = `${l.sourceFile}::${l.sourceSymbol}`;
    (calls.get(k) ?? calls.set(k, []).get(k)!).push(l);
  }
  for (const list of calls.values()) list.sort((a, b) => a.sourceLine - b.sourceLine || (a.targetSymbol < b.targetSymbol ? -1 : 1));
  const access = new Map<string, NonNullable<ProjectAnalysis["symbolDataAccess"]>>();
  for (const d of summary.symbolDataAccess ?? []) {
    const k = `${d.file}::${d.symbol}`;
    (access.get(k) ?? access.set(k, []).get(k)!).push(d);
  }
  const lanes = new Map<string, string>();
  const id = idFactory("p");
  const lane = (name: string): string => {
    if (!lanes.has(name)) lanes.set(name, id(name, name));
    return lanes.get(name)!;
  };
  const body: string[] = [];
  const say = (from: string, to: string, text: string, arrow = "->>") => body.push(`  ${from}${arrow}${to}: ${mermaidLabel(text)}`);

  const client = lane("Client");
  const start = lane(laneOf(seed.file, seed.symbol));
  say(client, start, seed.title);

  const walk = (file: string, symbol: string, level: number, path: Set<string>): void => {
    const here = lane(laneOf(file, symbol));
    const key = `${file}::${symbol}`;
    for (const d of access.get(key) ?? []) {
      const target = d.access === "queue-publish" || d.access === "queue-consume" ? lane(`Queue ${d.datastore ?? d.entity}`) : lane(`DB ${d.entity}`);
      if (d.access === "queue-consume") say(target, here, `consume ${d.entity}`);
      else say(here, target, d.access === "queue-publish" ? `publish ${d.entity}` : `${d.sites[0]?.name ?? "query"}`);
    }
    const out = calls.get(key) ?? [];
    const shown = out.slice(0, fanOut);
    // The frames open around the calls drawn so far, outermost first.
    const frames = opts.frames?.get(file) ?? [];
    const open: Array<{ frame: SequenceFrame; inElse: boolean }> = [];
    const enter = (line: number) => {
      while (open.length && (line < open[open.length - 1]!.frame.line || line > open[open.length - 1]!.frame.endLine)) {
        open.pop();
        body.push("  end");
      }
      for (const f of frames) {
        if (line < f.line || line > f.endLine || open.some((o) => o.frame === f)) continue;
        const enclosing = open[open.length - 1]?.frame;
        if (enclosing && (f.line < enclosing.line || f.endLine > enclosing.endLine)) continue;
        open.push({ frame: f, inElse: false });
        body.push(`  ${f.kind} ${mermaidLabel(f.label)}`);
      }
      for (const o of open) {
        if (o.frame.kind === "alt" && !o.inElse && o.frame.elseLine && line >= o.frame.elseLine) {
          o.inElse = true;
          body.push("  else");
        }
      }
    };
    for (const l of shown) {
      enter(l.sourceLine);
      const callee = `${l.targetFile}::${l.targetSymbol}`;
      const to = lane(laneOf(l.targetFile, l.targetSymbol));
      const arrow = l.confidence === "AMBIGUOUS" ? "-)" : "->>";
      if (path.has(callee)) {
        say(here, to, `${short(l.targetSymbol)} ↻ recursion`, arrow);
        continue;
      }
      // An HTTP hop into another tier says the request, not the method it lands in.
      const text = l.relation === "http" ? `HTTP ${l.callName}` : short(l.targetSymbol);
      say(here, to, text + (l.confidence === "AMBIGUOUS" ? " ?" : ""), arrow);
      const before = body.length;
      if (level < depth) walk(l.targetFile, l.targetSymbol, level + 1, new Set([...path, callee]));
      else body.push(`  Note over ${to}: depth ${depth} reached`);
      // A call within the lane that led nowhere needs no return arrow to read.
      if (to !== here || body.length > before) say(to, here, "return", "-->>");
    }
    for (let i = open.length; i > 0; i--) body.push("  end");
    if (out.length > shown.length) body.push(`  Note over ${here}: +${out.length - shown.length} more calls`);
  };
  walk(seed.file, seed.symbol, 1, new Set([`${seed.file}::${seed.symbol}`]));

  say(start, client, "response", "-->>");
  const header = ["sequenceDiagram", `  title ${mermaidLabel(seed.title)}`];
  const participants = [...lanes].map(([name, pid]) => `  participant ${pid} as ${mermaidLabel(name)}`);
  return [...header, ...participants, ...body].join("\n") + "\n";
}

/** The files a sequence from `seed` walks into — what `sequenceFrames` needs to read. */
export function sequenceFiles(summary: ProjectAnalysis, seed: { file: string; symbol: string }, opts: SequenceOptions = {}): string[] {
  const depth = opts.depth ?? 8;
  const calls = new Map<string, SymbolLink[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.relation === "reference" || l.sourceSymbol === "(reference)" || l.navigational) continue;
    const k = `${l.sourceFile}::${l.sourceSymbol}`;
    (calls.get(k) ?? calls.set(k, []).get(k)!).push(l);
  }
  const files = new Set([seed.file]);
  const seen = new Set<string>();
  let frontier = [`${seed.file}::${seed.symbol}`];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const k of frontier) {
      if (seen.has(k)) continue;
      seen.add(k);
      for (const l of calls.get(k) ?? []) {
        files.add(l.targetFile);
        next.push(`${l.targetFile}::${l.targetSymbol}`);
      }
    }
    frontier = next;
  }
  return [...files];
}
