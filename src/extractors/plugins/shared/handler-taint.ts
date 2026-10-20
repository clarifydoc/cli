import type { Node, Tree } from "web-tree-sitter";
import type { SecurityCategory, SecurityIssue, TaintFacts } from "../../../types/analysis.js";

/**
 * Request input followed through ONE request handler to a dangerous call —
 * the cheap, deterministic slice of taint analysis that answers "does what
 * the client sends reach this query / command / file path / URL / redirect".
 *
 * Seeds are only request input — the handler's request object read
 * (`request.args`, `req.query`), or a parameter a framework fills from the
 * request — never "every parameter", which buries real findings in noise.
 * Taint follows the handler's assignments in source order; a sanitizer
 * (`int()`, `parseInt`, `shlex.quote`, `secure_filename` …) clears it, and so
 * does reassigning the name from clean data. A sink fires on the argument
 * that carries the danger (a query's TEXT, not its bound parameters), so a
 * parameterized query never reports.
 *
 * Across functions of the same file: input passed to another function the
 * file declares (`build_query(name)`, `self.lookup(id)`) is followed into it
 * with that parameter tainted — its sinks report with the whole path — and a
 * helper that returns a tainted parameter taints its caller's result. Two
 * calls deep at most; a helper in another file is not followed (`entries` on
 * findings covers reachability).
 *
 * The plugin supplies the grammar's shapes and the vocabulary; this module
 * owns the algorithm.
 */
export interface TaintSpec {
  /** Function node types. */
  functionTypes: ReadonlySet<string>;
  /**
   * Whether `fn` handles a request, and which of its parameters the
   * framework fills from the request (`null` = not a handler).
   */
  handler(fn: Node): { taintedParams: string[] } | null;
  /** An expression that reads request input (`request.args[…]`, `req.body.x`). */
  source: RegExp;
  /** Assignments in a body: the names bound, the value expression. */
  assignment(node: Node): { names: string[]; value: Node } | null;
  /** A call in a body: callee text and its arguments in order. */
  call(node: Node): { callee: string; args: Node[] } | null;
  /** A value wrapped whole in a sanitizer call. */
  sanitizer: RegExp;
  /**
   * Calls whose result carries their arguments' taint — path joins, string
   * formatting, URL joins. Any other function's result is not followed: what
   * `self.service.render(name)` returns is not `name`. A method called ON a
   * tainted value (`name.strip()`) still carries it, through its receiver.
   */
  propagator: RegExp;
  /** Statement types whose condition can check a value (`if`). */
  ifTypes: ReadonlySet<string>;
  sinks: readonly TaintSink[];
  /**
   * The grammar's string literal node types, whose text is data — only their
   * interpolations (`interpolationTypes`) are code. Added to the defaults
   * (`string`, `template_string`, `concatenated_string`).
   */
  stringTypes?: ReadonlySet<string>;
  /** Node types inside a string that are code (`{name}` in C#, `$id` in PHP). */
  interpolationTypes?: ReadonlySet<string>;
  /** A function's name (default: its `name` field). */
  functionName?(fn: Node): string | null;
  /** A function's parameter names in order (default: read off its parameter list). */
  paramNames?(fn: Node): string[];
  /** Return statement types (default: `return_statement`). */
  returnTypes?: ReadonlySet<string>;
  /** An `if`'s condition (default: its `condition` field). */
  condition?(ifNode: Node): Node | null;
}

type Step = { line: number; note: string };

export type { TaintFacts } from "../../../types/analysis.js";
type Taint = { line: number; path: Step[] };
/** How deep calls into the file's own functions are followed. */
const MAX_DEPTH = 2;

/**
 * A condition that checks a value before use: `safe_for_redirect(url)`,
 * `resolved.startsWith(root)`, `is_valid(x)`, `x in ALLOWED`, `commonpath`,
 * `IsPathWithinDirectory(root, name)`, `Regex.IsMatch(ext, pattern)`.
 * A tainted name such a condition mentions counts as checked from there on —
 * whether the `if` wraps the sink or exits early when the check fails.
 */
const GUARD_RE = /\b(?:\w*safe\w*|\w*[Vv]alid\w*|\w*[Aa]llowed\w*|\w*whitelist\w*|\w*[Ww]ithin\w*|\w*[Ii]nside\w*|startswith|startsWith|StartsWith|endswith|endsWith|EndsWith|commonpath|is_relative_to|isAbsolute|realpath|IsMatch|matches|preg_match)\s*\(|\bin\s+[A-Z_]{3,}\b|\.includes\s*\(/;

export interface TaintSink {
  callee: RegExp;
  /** Which argument carries the danger (0 = first). */
  arg?: number;
  category: SecurityCategory;
  cwe: string;
  /** What reaches it, for the message: "the SQL text", "the command". */
  what: string;
}

/** Every request handler in `tree`, followed from its request input to the sinks. */
export function handlerTaint(tree: Tree, spec: TaintSpec, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  const out: SecurityIssue[] = [];
  const seen = new Set<string>();
  // The file's functions by name, for following input into a helper.
  const byName = new Map<string, Node[]>();
  const index = (node: Node): void => {
    if (spec.functionTypes.has(node.type)) {
      const name = (spec.functionName ?? defaultFunctionName)(node);
      if (name) (byName.get(name) ?? byName.set(name, []).get(name)!).push(node);
    }
    for (const c of node.namedChildren) index(c);
  };
  index(tree.rootNode);
  const ctx: FileContext = { spec, filePath, byName, summaries: new Map(), ...(facts ? { facts } : {}) };
  const visit = (node: Node): void => {
    if (spec.functionTypes.has(node.type)) {
      const handler = spec.handler(node);
      if (handler) {
        const params = handler.taintedParams;
        for (const issue of taintFunction(node, new Map(params.map((p) => [p, null])), ctx, 0)) {
          const key = `${issue.line}\u0000${issue.category}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(issue);
          }
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  if (facts) summarize(tree.rootNode, ctx, facts);
  return out;
}

/** Each function that is not a handler: which of its parameters reach a sink, for callers in other files. */
function summarize(root: Node, ctx: FileContext, facts: TaintFacts): void {
  const { spec } = ctx;
  const visit = (node: Node): void => {
    if (spec.functionTypes.has(node.type) && !spec.handler(node)) {
      const name = (spec.functionName ?? defaultFunctionName)(node);
      const params = (spec.paramNames ?? defaultParamNames)(node).filter((p) => !/^(?:self|cls|this)$/.test(p));
      const all = (spec.paramNames ?? defaultParamNames)(node);
      if (name && params.length > 0) {
        const seeds = new Map<string, Taint>(params.map((p) => {
          const line = node.startPosition.row + 1;
          return [p, { line, path: [{ line, note: `parameter ${p}` }] }];
        }));
        const sinks: TaintFacts["summaries"][number]["sinks"] = [];
        for (const issue of taintFunction(node, seeds, { ...ctx, facts: undefined }, 1)) {
          const first = issue.flow?.[0]?.note ?? "";
          const p = /^parameter (\S+)/.exec(first)?.[1];
          // As an argument position: a method's `self`/`cls` is its receiver, not an argument.
          const index = p ? all.indexOf(p) - (/^(?:self|cls)$/.test(all[0] ?? "") ? 1 : 0) : -1;
          if (index < 0) continue;
          const sinkNote = issue.flow![issue.flow!.length - 1]!.note;
          sinks.push({ param: index, line: issue.line, category: issue.category, cwe: issue.cwe ?? "", what: /reaches (.+?) of /.exec(sinkNote)?.[1] ?? "a sink", callee: /of (\S+)\(\)/.exec(sinkNote)?.[1] ?? "", path: issue.flow!.slice(1) });
        }
        if (sinks.length) facts.summaries.push({ name, line: node.startPosition.row + 1, sinks });
      }
    }
    for (const c of node.namedChildren) visit(c);
  };
  visit(root);
}

interface FileContext {
  spec: TaintSpec;
  filePath: string;
  byName: Map<string, Node[]>;
  /** Per function and tainted-parameter set: its findings and whether it returns taint. */
  summaries: Map<string, { issues: SecurityIssue[]; returns: Taint | null }>;
  /** Where calls into other files are recorded (handlers only). */
  facts?: TaintFacts;
}

function defaultFunctionName(fn: Node): string | null {
  return fn.childForFieldName("name")?.text ?? null;
}

/** Parameter names in order, read off the parameter list whatever the grammar calls its parts. */
function defaultParamNames(fn: Node): string[] {
  const list = fn.childForFieldName("parameters") ?? fn.namedChildren.find((c) => /parameters|parameter_list/.test(c.type));
  const nameOf = (p: Node): string | null => {
    if (p.type === "identifier" || p.type === "variable_name") return p.text;
    const named = p.childForFieldName("name") ?? p.childForFieldName("pattern");
    if (named) return nameOf(named) ?? named.text;
    for (const c of p.namedChildren) {
      if (c.type === "identifier" || c.type === "variable_name") return c.text;
    }
    return null;
  };
  return (list?.namedChildren ?? []).filter((p) => !/comment|decorator|annotation|modifiers?$/.test(p.type)).map(nameOf).filter((n): n is string => !!n);
}

/**
 * Follow taint through `fn`. `params` are its tainted parameters, each with
 * the path that brought taint to it (null: a handler's request parameter).
 */
function taintFunction(fn: Node, params: ReadonlyMap<string, Taint | null>, ctx: FileContext, depth: number, returns?: { out: Taint | null }): SecurityIssue[] {
  const { spec, filePath } = ctx;
  const body = fn.childForFieldName("body") ?? fn;
  const stringTypes = spec.stringTypes ? new Set([...STRING_CONTAINERS, ...spec.stringTypes]) : STRING_CONTAINERS;
  const interpolations = spec.interpolationTypes ? new Set([...INTERPOLATIONS, ...spec.interpolationTypes]) : INTERPOLATIONS;
  const fnLine = fn.startPosition.row + 1;
  /** The line a parameter is declared on: its name in the signature, not the function's first line (an annotation). */
  const paramLine = (name: string): number => {
    const find = (n: Node): Node | null => {
      if (n.id === body.id) return null;
      if (n.childCount === 0 ? n.text === name : (n.type === "variable_name" && n.text === name)) return n;
      for (const c of n.children) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    return (find(fn)?.startPosition.row ?? fn.startPosition.row) + 1;
  };
  /** Each tainted name: where its taint comes from, and the steps that carried it there. */
  const tainted = new Map<string, Taint>([...params].map(([p, from]) => {
    if (from) return [p, from];
    const line = paramLine(p);
    return [p, { line, path: [{ line, note: `request parameter ${p}` }] }];
  }));
  const returnTypes = spec.returnTypes ?? RETURN_TYPES;
  const issues: SecurityIssue[] = [];
  // The line of the statement being read: a request read counts from there.
  let sourceLine = 0;
  /** Where the taint in `text` comes from and how it got here, or null when it carries none. */
  const isTainted = (text: string): Taint | null => {
    if (spec.source.test(text)) return { line: sourceLine, path: [{ line: sourceLine, note: "request input read here" }] };
    for (const [name, t] of tainted) if (mentions(text, name)) return t;
    return null;
  };

  /**
   * A node's text with string literal contents left out and interpolations
   * kept (`"… WHERE name = %s"` names no variable, `f"… {name}"` does), and
   * with the arguments of calls that do not propagate taint dropped (their
   * callee, receiver included, is kept).
   */
  const codeText = (n: Node): string => {
    if (stringTypes.has(n.type)) {
      return n.namedChildren.filter((c) => interpolations.has(c.type)).map(codeText).join(" ");
    }
    if (n.childCount === 0) return n.text;
    // A sanitizer anywhere in an expression cleans what it wraps (`build_sql(int(request.GET["n"]))`).
    if (spec.call(n) && spec.sanitizer.test(n.text)) return "";
    const call = spec.call(n);
    if (call && !spec.propagator.test(call.callee) && !spec.source.test(n.text)) {
      // A helper of this file that returns a tainted argument carries it.
      const carried = helperReturn(call);
      return carried ? `${call.callee} ${carried}` : call.callee;
    }
    // Tokens joined as written, with a space only where two words would fuse
    // (`not name`), so `request.args` stays one expression.
    let out = "";
    for (const part of n.children.map(codeText)) {
      // PHP's `$name` is two tokens, `$` and `name`: no space after a bare sigil.
      if (out && part && /[\w$]$/.test(out) && !/(?:^|[^\w$])\$$/.test(out) && /^[\w$]/.test(part)) out += " ";
      out += part;
    }
    return out;
  };

  /** The one function of this file a call names, and how its arguments map onto its parameters. */
  const calleeOf = (call: { callee: string; args: Node[] }): { fn: Node; params: string[]; offset: number } | null => {
    if (depth >= MAX_DEPTH) return null;
    const leaf = call.callee.split(/[.:>\\]+/).pop() ?? "";
    const cands = (ctx.byName.get(leaf) ?? []).filter((f) => f.id !== fn.id && !spec.handler(f));
    if (cands.length !== 1) return null;
    const target = cands[0]!;
    const params = (spec.paramNames ?? defaultParamNames)(target);
    // `self.lookup(id)`: the method's first parameter is the receiver.
    const offset = /^(?:self|cls)$/.test(params[0] ?? "") && /^(?:self|cls)\./.test(call.callee) ? 1 : 0;
    return { fn: target, params, offset };
  };
  /** Follow tainted arguments into a helper; its findings and whether it returns taint, memoized. */
  const follow = (call: { callee: string; args: Node[] }, line: number): { issues: SecurityIssue[]; returns: Taint | null } | null => {
    const target = calleeOf(call);
    if (!target) return null;
    const into = new Map<string, Taint>();
    call.args.forEach((arg, i) => {
      const param = target.params[i + target.offset];
      if (!param || spec.sanitizer.test(arg.text)) return;
      const from = isTainted(codeText(arg));
      if (from) into.set(param, { line: from.line, path: [...from.path, { line, note: `passed to ${call.callee}() as ${param}` }] });
    });
    if (into.size === 0) return null;
    const key = `${target.fn.id}\u0000${[...into.keys()].sort().join(",")}`;
    const memo = ctx.summaries.get(key);
    if (memo) return memo;
    const ret = { out: null as Taint | null };
    ctx.summaries.set(key, { issues: [], returns: null }); // a recursive call sees nothing
    const summary = { issues: taintFunction(target.fn, into, ctx, depth + 1, ret), returns: ret.out };
    ctx.summaries.set(key, summary);
    return summary;
  };
  /** The tainted name a helper's result carries, for `codeText`: a parameter it returns. */
  const helperReturn = (call: { callee: string; args: Node[] }): string | null => {
    const s = follow(call, sourceLine);
    if (!s?.returns) return null;
    const name = `__returned_${sourceLine}_${s.returns.line}`;
    tainted.set(name, { line: s.returns.line, path: [...s.returns.path, { line: sourceLine, note: `returned by ${call.callee}()` }] });
    return name;
  };

  const walk = (node: Node): void => {
    if (returns && returnTypes.has(node.type)) {
      const value = node.namedChildren[0];
      const from = value ? isTainted(codeText(value)) : null;
      if (from && !returns.out) returns.out = from;
    }
    // Nested handlers are their own.
    if (node.id !== fn.id && spec.functionTypes.has(node.type) && spec.handler(node)) return;
    if (spec.ifTypes.has(node.type)) {
      const cond = (spec.condition ? spec.condition(node) : node.childForFieldName("condition"))?.text ?? "";
      if (GUARD_RE.test(cond)) {
        for (const name of [...tainted.keys()]) {
          if (mentions(cond, name)) tainted.delete(name);
        }
      }
    }
    const a = spec.assignment(node);
    if (a) {
      // The value is evaluated before the names are bound: calls inside it first.
      walk(a.value);
      sourceLine = node.startPosition.row + 1;
      const from = spec.sanitizer.test(a.value.text) ? null : isTainted(codeText(a.value));
      for (const n of a.names) {
        if (from === null) {
          tainted.delete(n);
          continue;
        }
        const last = from.path[from.path.length - 1];
        const step = { line: sourceLine, note: `${n} carries it` };
        tainted.set(n, { line: from.line, path: last?.line === sourceLine ? [...from.path.slice(0, -1), { line: sourceLine, note: `${last.note}; ${n} carries it` }] : [...from.path, step] });
      }
      return;
    }
    const c = spec.call(node);
    if (c) {
      sourceLine = node.startPosition.row + 1;
      for (const sink of spec.sinks) {
        if (!sink.callee.test(c.callee)) continue;
        const arg = c.args[sink.arg ?? 0];
        if (!arg || spec.sanitizer.test(arg.text)) continue;
        const from = isTainted(codeText(arg));
        if (from === null) continue;
        const line = node.startPosition.row + 1;
        const sinkNote = `reaches ${sink.what} of ${c.callee}()`;
        const flow = from.path[from.path.length - 1]?.line === line
          ? [...from.path.slice(0, -1), { line, note: `${from.path[from.path.length - 1]!.note}; ${sinkNote}` }]
          : [...from.path, { line, note: sinkNote }];
        issues.push({
          category: sink.category,
          severity: "high",
          message: `Request input${from.line !== line ? ` (from line ${from.line})` : ""} reaches ${sink.what} of ${c.callee}() unsanitized.`,
          filePath,
          line,
          snippet: node.text.split("\n")[0]!.trim().slice(0, 100),
          cwe: sink.cwe,
          ...(flow.length > 1 ? { flow } : {}),
        });
        break;
      }
      // Input passed to a helper of this file: what it reaches there.
      if (!spec.sinks.some((s) => s.callee.test(c.callee))) {
        const s = follow(c, node.startPosition.row + 1);
        if (s) issues.push(...s.issues);
        // A function another file declares: recorded for the project pass (handlers' own calls only).
        else if (ctx.facts && depth === 0 && !calleeOf(c) && !spec.propagator.test(c.callee) && !spec.sanitizer.test(node.text)) {
          const line = node.startPosition.row + 1;
          const args = c.args.flatMap((arg, index) => {
            if (spec.sanitizer.test(arg.text)) return [];
            const from = isTainted(codeText(arg));
            return from ? [{ index, from: from.line, path: from.path }] : [];
          });
          if (args.length) ctx.facts.calls.push({ line, callee: c.callee, args });
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(body);
  return issues;
}

const RETURN_TYPES: ReadonlySet<string> = new Set(["return_statement"]);

/** String containers whose interpolations are code (`f"…{x}…"`, `` `…${x}…` ``). */
const STRING_CONTAINERS: ReadonlySet<string> = new Set(["string", "template_string", "concatenated_string"]);
const INTERPOLATIONS: ReadonlySet<string> = new Set(["interpolation", "template_substitution", "string"]);

/**
 * Whether `text` mentions the variable `name` — not as another name's member
 * (`obj.name`). A sigil name (PHP's `$id`) is never a member: a `.` before it
 * is concatenation.
 */
function mentions(text: string, name: string): boolean {
  const before = name.startsWith("$") ? "(?<![\\w$])" : "(?<![\\w$.])";
  return new RegExp(`${before}${escape(name)}(?![\\w$])`).test(text);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The identifiers a binding target names (`x`, `a, b`, `{ id, name: n }`, `[first]`). */
export function boundIdentifiers(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === "identifier" || node.type === "shorthand_property_identifier_pattern") return [node.text];
  if (node.type === "pair_pattern") return boundIdentifiers(node.childForFieldName("value"));
  const out: string[] = [];
  for (const c of node.namedChildren) out.push(...boundIdentifiers(c));
  return out;
}
