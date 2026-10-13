import type { Cfg, CfgNode } from "../types/control-flow.js";

/**
 * A backward slice inside one function: the statements that can affect the
 * values used at a line — "what builds `sql` before `db.query(sql)`, on every
 * path". Computed on the function's control-flow graph:
 *
 *  - data dependences by reaching definitions, so BOTH arms of an `if` that
 *    assign the value are in the slice (a "latest assignment above" search
 *    keeps only one);
 *  - control dependences by post-dominators, so the `if` that decides whether
 *    an assignment runs is in it too.
 *
 * Definitions and uses are read off each node's source text — assignment
 * targets, loop variables, then every other identifier — the same way for
 * every language with a graph, so it is approximate where a language assigns
 * through a call or a pointer. Names used but never assigned in the function
 * are reported as coming from its parameters or enclosing scope.
 */
export interface BackwardSlice {
  /** The line the slice is taken at. */
  line: number;
  /** The names used at that line, whose values the slice explains. */
  variables: string[];
  /** The statements in the slice, in source order. */
  statements: Array<{ line: number; endLine: number; text: string; why: "criterion" | "data" | "control" }>;
  /** Used names no statement of the function assigns: parameters, fields, globals. */
  fromOutside: string[];
}

const KEYWORDS = new Set([
  "if", "else", "elif", "for", "foreach", "while", "do", "return", "in", "of", "let", "const", "var", "val", "new",
  "await", "async", "def", "function", "fn", "func", "class", "import", "from", "as", "not", "and", "or", "is",
  "None", "null", "nil", "undefined", "true", "false", "True", "False", "this", "throw", "raise", "try", "catch",
  "except", "finally", "with", "yield", "lambda", "switch", "case", "default", "break", "continue", "pass",
  "typeof", "instanceof", "void", "delete", "static", "final", "public", "private", "protected", "readonly",
  "string", "int", "bool", "boolean", "number", "float", "double", "long", "char", "auto", "my", "local", "then",
  "end", "begin", "begin", "unless", "until", "when", "match", "where", "select", "out", "ref", "params",
]);

/** The slice at `line` of `cfg`, reading node text from `sourceLines` (1-based lines → index line-1). */
export function backwardSlice(cfg: Cfg, sourceLines: readonly string[], line: number): BackwardSlice | null {
  const nodes = cfg.nodes.filter((n) => n.kind !== "ENTRY" && n.kind !== "EXIT" && n.kind !== "MERGE");
  const textOf = new Map<string, string>();
  for (const n of nodes) {
    // A construct with other nodes inside it (an `if`, a loop, a `with`)
    // contributes its header line; a plain statement its whole span.
    const compound = n.kind === "DECISION" || n.kind === "LOOP" || n.kind === "CATCH" ||
      nodes.some((o) => o !== n && o.line > n.line && o.line <= n.endLine);
    const last = compound ? n.line : n.endLine;
    textOf.set(n.id, blankStrings(sourceLines.slice(n.line - 1, last).join("\n")));
  }
  const facts = new Map(nodes.map((n) => [n.id, defUse(textOf.get(n.id) ?? "", n)]));

  // The criterion: the innermost node covering the line.
  const at = nodes
    .filter((n) => n.line <= line && line <= n.endLine)
    .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line) || b.line - a.line)[0];
  if (!at) return null;

  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const e of cfg.edges) {
    (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to);
    (pred.get(e.to) ?? pred.set(e.to, []).get(e.to)!).push(e.from);
  }
  const all = cfg.nodes.map((n) => n.id);

  // Reaching definitions: per node, the set of `var@nodeId` that reach its entry.
  const gen = new Map<string, string[]>();
  for (const n of cfg.nodes) gen.set(n.id, (facts.get(n.id)?.defs ?? []).map((v) => `${v}@${n.id}`));
  const killsVar = (n: string) => new Set(facts.get(n)?.strongDefs ?? []);
  const reachIn = new Map<string, Set<string>>(all.map((id) => [id, new Set()]));
  const reachOut = new Map<string, Set<string>>(all.map((id) => [id, new Set(gen.get(id))]));
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    for (const id of all) {
      const inSet = new Set<string>();
      for (const p of pred.get(id) ?? []) for (const d of reachOut.get(p)!) inSet.add(d);
      reachIn.set(id, inSet);
      const killed = killsVar(id);
      const out = new Set(gen.get(id));
      for (const d of inSet) if (!killed.has(d.slice(0, d.lastIndexOf("@")))) out.add(d);
      if (out.size !== reachOut.get(id)!.size) { reachOut.set(id, out); changed = true; }
    }
  }

  // Post-dominators, for control dependence.
  const pdom = new Map<string, Set<string>>(all.map((id) => [id, id === cfg.exit ? new Set([id]) : new Set(all)]));
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    for (const id of all) {
      if (id === cfg.exit) continue;
      const ss = succ.get(id) ?? [];
      // The meet of the successors' post-dominator sets.
      let meet: string[] | null = null;
      for (const s of ss) {
        const ps = pdom.get(s)!;
        meet = meet === null ? [...ps] : meet.filter((x) => ps.has(x));
      }
      const next = new Set<string>(meet ?? []);
      next.add(id);
      if (next.size !== pdom.get(id)!.size) { pdom.set(id, next); changed = true; }
    }
  }
  /** The branch nodes `y` is control dependent on. */
  const controllers = (y: string): string[] => {
    const out: string[] = [];
    for (const x of all) {
      const ss = succ.get(x) ?? [];
      if (ss.length < 2 || x === y || pdom.get(x)!.has(y)) continue;
      if (ss.some((s) => s === y || pdom.get(s)!.has(y))) out.push(x);
    }
    return out;
  };

  const inSlice = new Map<string, "criterion" | "data" | "control">([[at.id, "criterion"]]);
  const outside = new Set<string>();
  const queue = [at.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const v of facts.get(id)?.uses ?? []) {
      const defs = [...reachIn.get(id)!].filter((d) => d.slice(0, d.lastIndexOf("@")) === v).map((d) => d.slice(d.lastIndexOf("@") + 1));
      if (defs.length === 0 && !nodes.some((n) => facts.get(n.id)!.defs.includes(v))) outside.add(v);
      for (const d of defs) if (!inSlice.has(d)) { inSlice.set(d, "data"); queue.push(d); }
    }
    for (const c of controllers(id)) {
      if (cfg.nodes.find((n) => n.id === c)?.kind === "ENTRY") continue;
      if (!inSlice.has(c)) { inSlice.set(c, "control"); queue.push(c); }
    }
  }

  const byId = new Map(cfg.nodes.map((n) => [n.id, n]));
  const statements = [...inSlice]
    .map(([id, why]) => ({ n: byId.get(id)!, why }))
    .filter(({ n }) => n && n.kind !== "ENTRY" && n.kind !== "EXIT" && n.kind !== "MERGE")
    .sort((a, b) => a.n.line - b.n.line)
    .map(({ n, why }) => {
      const compound = (textOf.get(n.id) ?? "").split("\n").length === 1 && n.endLine > n.line;
      return { line: n.line, endLine: compound ? n.line : n.endLine, text: sourceLines.slice(n.line - 1, compound ? n.line : n.endLine).join("\n").trim(), why };
    });
  return { line, variables: facts.get(at.id)!.uses, statements, fromOutside: [...outside].sort() };
}

/** Whether every `(` and `[` in `s` is closed. */
function balanced(s: string): boolean {
  let paren = 0;
  let bracket = 0;
  for (const c of s) {
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
  }
  return paren === 0 && bracket === 0;
}

/** String literal contents blanked, interpolations (`${x}`, `{x}` in f-strings, `#{x}`) kept. */
function blankStrings(text: string): string {
  return text.replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, (_m, q: string, body: string) => {
    const holes = [...body.matchAll(/\$\{([^}]*)\}|#\{([^}]*)\}|\{([A-Za-z_][^{}]*)\}/g)].map((h) => h[1] ?? h[2] ?? h[3]).join(" ");
    return `${q}${holes ? ` ${holes} ` : ""}${q}`;
  });
}

/** Definitions (`strongDefs` replace the value, the rest add to it) and uses in a node's text. */
function defUse(text: string, node: CfgNode): { defs: string[]; strongDefs: string[]; uses: string[] } {
  const code = text.replace(/\/\/.*$|#(?![{\[]).*$/gm, "");
  const idents = (s: string) => [...s.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g)].map((m) => m[1]!).filter((x) => !KEYWORDS.has(x));
  // Loop variables: `for x in xs`, `for (const x of xs)`, `foreach (var x in xs)`.
  const loop = /\bfor(?:each)?\s*\(?\s*(?:(?:let|const|var|val|auto|final)\s+)?([\w$,\s()[\]{}]+?)\s+(?:in|of)\s+([\s\S]+)/.exec(code);
  if (node.kind === "LOOP" && loop) {
    const vars = idents(loop[1]!);
    return { defs: vars, strongDefs: vars, uses: idents(loop[2]!) };
  }
  if (node.kind === "STATEMENT") {
    // The first top-level `=` that is not `==`, `<=`, `>=`, `!=`, `=>`.
    const m = /^([\s\S]*?[^=!<>])((?:[-+*/%&|^]|\*\*|<<|>>|\?\?|\/\/)?=)(?![=>])([\s\S]*)$/.exec(code);
    // An assignment only when the `=` is outside every bracket: `get(url, timeout=5)` is a call.
    if (m && balanced(m[1]!)) {
      const lhs = m[1]!.replace(/^\s*(?:let|const|var|val|final|auto|my|local|def)\s+/, "");
      const augmented = m[2] !== "=";
      // `obj.f = v` / `xs[i] = v` change part of a value: a use and a weak definition.
      const partial = /[.[]/.test(lhs.replace(/^\s*[\w$]+\s*:\s*[^=]+$/, ""));
      const declared = lhs.replace(/:\s*[^,=]+$/, "");
      const targets = idents(declared.replace(/\[[^\]]*\]|\.[\w$]+/g, ""));
      const named = partial ? targets.slice(0, 1) : targets.slice(-Math.max(1, (declared.match(/,/g)?.length ?? 0) + 1));
      const uses = [...new Set([...idents(m[3]!), ...(augmented || partial ? named : []), ...(partial ? idents(lhs).slice(1) : [])])];
      return { defs: named, strongDefs: augmented || partial ? [] : named, uses };
    }
  }
  return { defs: [], strongDefs: [], uses: [...new Set(idents(code))] };
}
