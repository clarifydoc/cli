import type { Node, Tree } from "web-tree-sitter";
import type { SecurityCategory, SecurityIssue } from "../../../types/analysis.js";

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
 * parameterized query never reports. Within one function only: input passed
 * on to a helper is not followed (`entries` on findings covers reachability).
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
}

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
export function handlerTaint(tree: Tree, spec: TaintSpec, filePath: string): SecurityIssue[] {
  const out: SecurityIssue[] = [];
  const seen = new Set<string>();
  const visit = (node: Node): void => {
    if (spec.functionTypes.has(node.type)) {
      const handler = spec.handler(node);
      if (handler) {
        for (const issue of taintFunction(node, handler.taintedParams, spec, filePath)) {
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
  return out;
}

function taintFunction(fn: Node, params: readonly string[], spec: TaintSpec, filePath: string): SecurityIssue[] {
  const body = fn.childForFieldName("body") ?? fn;
  type Step = { line: number; note: string };
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
  const tainted = new Map<string, { line: number; path: Step[] }>(params.map((p) => {
    const line = paramLine(p);
    return [p, { line, path: [{ line, note: `request parameter ${p}` }] }];
  }));
  const issues: SecurityIssue[] = [];
  // The line of the statement being read: a request read counts from there.
  let sourceLine = 0;
  /** Where the taint in `text` comes from and how it got here, or null when it carries none. */
  const isTainted = (text: string): { line: number; path: Step[] } | null => {
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
    const call = spec.call(n);
    if (call && !spec.propagator.test(call.callee) && !spec.source.test(n.text)) return call.callee;
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

  const walk = (node: Node): void => {
    // Nested handlers are their own.
    if (node.id !== fn.id && spec.functionTypes.has(node.type) && spec.handler(node)) return;
    if (spec.ifTypes.has(node.type)) {
      const cond = node.childForFieldName("condition")?.text ?? "";
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
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(body);
  return issues;
}

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
