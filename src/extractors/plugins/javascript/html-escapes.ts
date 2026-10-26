/**
 * A second look at an `innerHTML` / `outerHTML` assignment: is every value it
 * interpolates escaped? The pattern alone fires on any non-literal right-hand
 * side, so a table rendered as
 *
 *   el.innerHTML = rows.map((r) => `<td>${esc(r.name)}</td><td>${Number(r.goals)}</td>`).join("");
 *
 * was reported as a high-severity XSS although no raw value reaches the HTML.
 * A "high" on an escaped template trains people to ignore the category, so
 * such a statement is re-graded low, saying why.
 *
 * Holes are the `${…}` of every template literal in the statement and the
 * non-literal operands of a `+` that joins a string literal. A hole that is
 * itself a template-building expression (`${items.map((i) => `<li>${esc(i)}</li>`).join("")}`)
 * is judged by its own holes. The statement is re-graded only when it has at
 * least one hole and every hole is a call of an escaper or sanitizer (`esc`,
 * `escapeHtml`, `DOMPurify.sanitize`, `encodeURIComponent`), a number
 * conversion (`Number`, `parseInt`, `.toFixed()`), a number literal or a
 * `.length` — a bare variable (`el.innerHTML = html`) has no hole to judge and
 * stays as it is.
 */
import type { SecurityJudgement } from "../../../types/language-plugin.js";

/** A callee whose name says its result is safe to put in HTML. */
const SAFE_CALLEE =
  /^(?:[\w$]+\.)*(?:esc(?:[A-Z_]\w*)?|escape\w*|\w*Escape\w*|\w*_escape\w*|sanitize\w*|\w*Sanitize\w*|purify|encodeURI(?:Component)?|Number|parseInt|parseFloat|Math\.\w+)$/;

const MAX_STATEMENT = 6000;

/** Index just past the string or template starting at `i` (a quote char), skipping escapes; templates recurse through `${}`. */
function skipQuoted(s: string, i: number): number {
  const q = s[i]!;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === q) return j + 1;
    if (q === "`" && c === "$" && s[j + 1] === "{") { j = skipBalanced(s, j + 1); continue; }
    if (q !== "`" && c === "\n") return j;
    j++;
  }
  return j;
}

/** Index just past the bracket group opening at `i` (`(`, `[` or `{`), strings and templates skipped. */
function skipBalanced(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(s, j); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/** The right-hand side of the assignment whose `innerHTML` starts at `at`: up to the `;` (or line end) at depth 0. */
function rightHandSide(source: string, at: number): string | null {
  const eq = source.indexOf("=", at);
  if (eq < 0) return null;
  let j = eq + 1;
  const end = Math.min(source.length, j + MAX_STATEMENT);
  while (j < end) {
    const c = source[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(source, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(source, j); continue; }
    if (c === ";" || c === ")" || c === "}" || c === "]") break;
    if (c === "\n") {
      // A statement continued on the next line (`+`, `.join(…)`, `?` / `:`), else its end.
      const before = source.slice(eq + 1, j).trimEnd();
      const after = source.slice(j + 1, j + 200).trimStart();
      if (!/[+(,?:=]$/.test(before) && !/^[.+?:]/.test(after)) break;
    }
    j++;
  }
  if (j >= end && end < source.length) return null;
  return source.slice(eq + 1, j).trim();
}

/** `expr` split at its top-level `+` operators. */
function concatOperands(expr: string): string[] {
  const out: string[] = [];
  let from = 0;
  let j = 0;
  while (j < expr.length) {
    const c = expr[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(expr, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(expr, j); continue; }
    if (c === "+" && expr[j + 1] !== "+" && expr[j + 1] !== "=" && expr[j - 1] !== "+") {
      out.push(expr.slice(from, j).trim());
      from = j + 1;
    }
    j++;
  }
  out.push(expr.slice(from).trim());
  return out.filter((o) => o.length > 0);
}

/** The `${…}` contents of the template literal spanning all of `lit`. */
function templateHoles(lit: string): string[] {
  const out: string[] = [];
  let j = 1;
  while (j < lit.length - 1) {
    const c = lit[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === "$" && lit[j + 1] === "{") {
      const close = skipBalanced(lit, j + 1);
      out.push(lit.slice(j + 2, close - 1).trim());
      j = close;
      continue;
    }
    j++;
  }
  return out;
}

const isStringLiteral = (e: string): boolean =>
  (e.startsWith("'") || e.startsWith('"')) && skipQuoted(e, 0) === e.length;
const isTemplateLiteral = (e: string): boolean => e.startsWith("`") && skipQuoted(e, 0) === e.length;

/** `s` split at the depth-0 occurrences of any of `seps`, strings and bracket groups skipped. */
function splitTop(s: string, seps: string): string[] {
  const out: string[] = [];
  let from = 0;
  let j = 0;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(s, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(s, j); continue; }
    if (seps.includes(c)) {
      out.push(s.slice(from, j));
      from = j + 1;
    }
    j++;
  }
  out.push(s.slice(from));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Whether the bracket group opening at 0 spans all of `s`. */
const spans = (s: string): boolean => skipBalanced(s, 0) === s.length;

/** Locals the statement declares (`const pct = Math.round(…)`), by name — what an identifier hole holds. */
type Locals = Map<string, string>;

/** A value that cannot carry markup: an escaper's or a number conversion's result, a number, a length, a constant table's entry. */
function isSafeValue(e: string, locals: Locals, seen = new Set<string>(), numbersOnly = false): boolean {
  let v = e.trim();
  while (v.startsWith("(") && spans(v)) v = v.slice(1, -1).trim();
  if (isStringLiteral(v)) return !numbersOnly;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return true;
  if (/^[\w$.]+\.length$/.test(v)) return true;
  if (/\.toFixed\(\s*\d*\s*\)$/.test(v) && !v.includes("`")) return true;
  // A lookup in a constant table (`COLOURS[type]`): the table's values, not the key, land in the markup.
  if (/^[A-Z][A-Z0-9_]*\[[^\]]*\]$/.test(v)) return true;
  // `cond ? a : b` — safe when both branches are.
  const q = splitTop(v, "?");
  if (q.length === 2) {
    const branches = splitTop(q[1]!, ":");
    if (branches.length === 2) return branches.every((b) => isSafeValue(b, locals, seen, numbersOnly));
  }
  const ident = /^[A-Za-z_$][\w$]*$/.exec(v);
  if (ident) {
    const def = locals.get(v);
    if (def === undefined || seen.has(v)) return false;
    seen.add(v);
    return isSafeValue(def, locals, seen, numbersOnly);
  }
  const call = /^([\w$.]+)\s*\(/.exec(v);
  if (call && skipBalanced(v, call[0].length - 1) === v.length) {
    if (SAFE_CALLEE.test(call[1]!)) return true;
    // A function of numbers only (`fmt(Number(goals))`) is handed nothing that can carry markup —
    // a string argument (`el.getAttribute("score")`) names what it reads, so it does not count.
    const args = splitTop(v.slice(call[0].length, -1), ",");
    if (args.length > 0 && args.every((a) => isSafeValue(a, locals, seen, true))) return true;
  }
  return false;
}

/** Holes judged so far; `ok` false once one is neither safe nor a markup-building expression to look into. */
interface Tally { holes: number; ok: boolean }

/**
 * One value that lands in the markup. Safe values count; a value that builds
 * markup itself (a concatenation, a template, `cond ? '<i>…</i>' : ''`) is
 * judged by what IT interpolates; a frame around markup (`rows.map(…).join("")`)
 * must show at least one judged hole. Anything else fails the statement.
 */
function judgeHole(raw: string, locals: Locals, t: Tally): void {
  let hole = raw.trim();
  while (hole.startsWith("(") && spans(hole)) hole = hole.slice(1, -1).trim();
  if (isStringLiteral(hole)) return;
  if (isSafeValue(hole, locals)) { t.holes++; return; }
  const q = splitTop(hole, "?");
  if (q.length === 2) {
    const branches = splitTop(q[1]!, ":");
    if (branches.length === 2) {
      for (const b of branches) judgeHole(b, locals, t);
      return;
    }
  }
  if (isTemplateLiteral(hole)) {
    for (const h of templateHoles(hole)) judgeHole(h, locals, t);
    return;
  }
  if (concatOperands(hole).length > 1) {
    judgeExpr(hole, locals, t);
    return;
  }
  if (/[([{`]/.test(hole)) {
    const before = t.holes;
    judgeFrame(hole, locals, t);
    if (t.holes === before) t.ok = false;
    return;
  }
  t.ok = false;
}

/** The values a right-hand side puts in the markup, tallied into `t`: every operand of a concatenation is one. */
function judgeExpr(expr: string, locals: Locals, t: Tally): void {
  for (const o of concatOperands(expr)) {
    if (!t.ok) return;
    judgeHole(o, locals, t);
  }
}

/**
 * The frame around the markup (`rows.map(([club, pts]) => { const p = …; return '<li>' + esc(club) + '</li>'; }).join("")`):
 * the markup is built inside its bracket groups — a callback's returned value,
 * an arrow's expression — so each is looked into, the locals it declares
 * recorded for the identifiers its holes name.
 */
function judgeFrame(frame: string, locals: Locals, t: Tally): void {
  let j = 0;
  while (j < frame.length && t.ok) {
    const c = frame[j]!;
    if (c === "'" || c === '"') { j = skipQuoted(frame, j); continue; }
    if (c === "`") {
      const end = skipQuoted(frame, j);
      for (const h of templateHoles(frame.slice(j, end))) judgeHole(h, locals, t);
      j = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      const end = skipBalanced(frame, j);
      judgeStatements(frame.slice(j + 1, end - 1), new Map(locals), t);
      j = end;
      continue;
    }
    j++;
  }
}

/** `body` split into statements and list items: depth-0 `;` and `,`, and line ends that end a statement. */
function statementsOf(body: string): string[] {
  const out: string[] = [];
  let from = 0;
  let j = 0;
  while (j < body.length) {
    const c = body[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(body, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(body, j); continue; }
    let cut = c === ";" || c === ",";
    if (c === "\n") {
      const before = body.slice(from, j).trimEnd();
      const after = body.slice(j + 1, j + 200).trimStart();
      cut = before.length > 0 && !/[+(,?:=]$/.test(before) && !/^[.+?:)\]]/.test(after);
    }
    if (cut) {
      out.push(body.slice(from, j));
      from = j + 1;
    }
    j++;
  }
  out.push(body.slice(from));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The statements of a bracket group: a returned value or an arrow's expression lands in the markup; the rest is frame. */
function judgeStatements(body: string, locals: Locals, t: Tally): void {
  for (let piece of statementsOf(body)) {
    if (!t.ok) return;
    let isValue = false;
    const ret = /^return\b\s*/.exec(piece);
    if (ret) {
      piece = piece.slice(ret[0].length);
      isValue = true;
    }
    const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(piece);
    if (decl) {
      locals.set(decl[1]!, decl[2]!);
      continue;
    }
    // An arrow's head (`([club, pts]) =>`, `async (x) =>`, `p =>`): its body is the piece.
    const bare = /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>\s*/.exec(piece);
    if (bare) {
      piece = piece.slice(bare[0].length);
      isValue = true;
    } else {
      const open = /^(?:async\s*)?\(/.exec(piece);
      if (open) {
        const close = skipBalanced(piece, open[0].length - 1);
        const arrow = /^\s*=>\s*/.exec(piece.slice(close));
        if (arrow) {
          piece = piece.slice(close + arrow[0].length);
          isValue = true;
        }
      }
    }
    if (piece.startsWith("{") && spans(piece)) {
      judgeStatements(piece.slice(1, -1), new Map(locals), t);
      continue;
    }
    if (isValue) judgeHole(piece, locals, t);
    else judgeFrame(piece, locals, t);
  }
}

/** `SecurityRule.judge` for the `innerHTML` rule: re-grade an assignment whose every interpolated value is escaped. */
export function judgeHtmlAssignment(source: string, at: number): SecurityJudgement | undefined {
  const rhs = rightHandSide(source, at);
  if (!rhs) return undefined;
  const tally: Tally = { holes: 0, ok: true };
  judgeExpr(rhs, new Map(), tally);
  if (!tally.ok || tally.holes === 0) return undefined;
  return {
    severity: "low",
    message: "innerHTML assignment whose every interpolated value passes an escaper or a number conversion. Check the escaper suits where the value lands (an attribute needs quotes escaped too).",
  };
}
