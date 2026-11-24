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

/**
 * The two branches of a conditional expression spanning all of `e` (`c ? a : b`; a nested one in the
 * else branch, `c ? a : d ? b : x`, stays whole there), or undefined. `?.` and `??` are no conditional.
 */
function ternaryBranches(e: string): [string, string] | undefined {
  let q = -1;
  let colon = -1;
  let nested = 0;
  let j = 0;
  while (j < e.length) {
    const c = e[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(e, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(e, j); continue; }
    if (c === "?") {
      if (e[j + 1] === "?" || (e[j + 1] === "." && !/\d/.test(e[j + 2] ?? ""))) { j += 2; continue; }
      if (q < 0) q = j;
      else nested++;
    } else if (c === ":" && q >= 0) {
      if (nested === 0) { colon = j; break; }
      nested--;
    }
    j++;
  }
  if (q < 0 || colon < 0) return undefined;
  const a = e.slice(q + 1, colon).trim();
  const b = e.slice(colon + 1).trim();
  return a && b ? [a, b] : undefined;
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
  // A length (`squad.length`, `edges.filter((e) => e.to === id).length`) is a number.
  if (/\.length$/.test(v) && concatOperands(v).length === 1 && !ternaryBranches(v)) return true;
  if (/\.toFixed\(\s*\d*\s*\)$/.test(v) && !v.includes("`")) return true;
  // A lookup in a constant table (`COLOURS[type]`, `PALETTE.blue`, `LIVERY[team].colour`): the table's values,
  // not the key, land in the markup.
  if (/^[A-Z][A-Z0-9_]*(?:\[[^\]]*\]|\.[\w$]+)+$/.test(v)) return true;
  // `cond ? a : b` — safe when both branches are.
  const branches = ternaryBranches(v);
  if (branches) return branches.every((b) => isSafeValue(b, locals, seen, numbersOnly));
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

/**
 * Holes judged so far; `ok` false once one is neither safe nor a markup-building expression to look into.
 * `outer` reads what a name holds where the statement does not say: the file before it (`outerValues`).
 */
interface Tally { holes: number; ok: boolean; outer?: { source: string; at: number }; followed?: Set<string> }

/** An expression the file writes into a name, and where: the names IT reads are looked up from there. */
interface Written { expr: string; at: number }

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
  const branches = ternaryBranches(hole);
  if (branches) {
    for (const b of branches) judgeHole(b, locals, t);
    return;
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
  // A name the statement does not declare (`tip.innerHTML = html`, `${rows}`, `= r.tip`): every value the file
  // writes into it before the statement, each judged as markup.
  const outer = t.outer;
  if (outer && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(hole) && !locals.has(hole)) {
    const followed = (t.followed ??= new Set());
    const key = `${outer.at}:${hole}`;
    const values = followed.has(key) ? undefined : outerValues(outer.source, outer.at, hole);
    if (values && values.length > 0) {
      followed.add(key);
      for (const v of values) {
        if (!t.ok) break;
        if (v.expr === SANITIZED) {
          t.holes++;
          continue;
        }
        t.outer = { source: outer.source, at: v.at };
        judgeExpr(v.expr, locals, t);
      }
      t.outer = outer;
      return;
    }
  }
  t.ok = false;
}

/** A value a sanitizer produced (Mermaid's rendered SVG): it counts as one safe hole. */
const SANITIZED = "\0sanitized";

/** Type words a property written in an interface or a type holds (`tip: string;`): no value. */
const TYPE_WORD = /^(?:string|number|boolean|unknown|any|null|undefined|never|object)\b/;

/**
 * What the file writes into `name` before offset `at`, as the expressions it
 * writes: a local's declaration and each `name = …` / `name += …` after it; a
 * parameter of the function the statement sits in, the argument each call of
 * that function passes; a member read (`r.tip`), every value an object
 * literal or an assignment gives the member (`tip: \`…\``, `.tip = …`).
 * Undefined when the file says nothing, or something no judge reads.
 */
function outerValues(source: string, at: number, name: string): Written[] | undefined {
  const dot = name.indexOf(".");
  if (dot >= 0) return memberValues(source, name.slice(dot + 1));
  const esc = name.replace(/\$/g, "\\$");
  const before = source.slice(0, at);
  // Mermaid's render output (`.then(({ svg }) => …)`, `const { svg } = await mermaid.render(…)`) is sanitized
  // unless the file turns its sanitizing off (`securityLevel: "loose"`).
  const rendered = new RegExp(String.raw`\bmermaid\s*\.\s*render\s*\([\s\S]{0,400}?\.then\s*\(\s*(?:async\s*)?\(\s*\{[^}]*\b${esc}\b|\{[^}]*\b${esc}\b[^}]*\}\s*=\s*await\s+mermaid\s*\.\s*render\s*\(`);
  if (rendered.test(before.slice(-2000)) && !/securityLevel\s*:\s*["'`](?:loose|sandbox)/.test(source)) return [{ expr: SANITIZED, at }];
  // `const html = …`, and the later names of one declaration (`const outs = …, ins = …`).
  const decl = [...before.matchAll(new RegExp(String.raw`(?:\b(?:const|let|var)\s+|,\s*)${esc}\s*(?::[^=;\n,]+)?=(?![=>])`, "g"))].at(-1);
  if (decl) {
    const out: Written[] = [];
    const first = valueAt(source, decl.index! + decl[0].length);
    if (first === null) return undefined;
    out.push({ expr: first, at: decl.index! });
    const writes = new RegExp(String.raw`(?<![\w$.])${esc}\s*\+?=(?![=>])`, "g");
    writes.lastIndex = decl.index! + decl[0].length;
    for (let m = writes.exec(before); m; m = writes.exec(before)) {
      const v = valueAt(source, m.index + m[0].length);
      if (v === null) return undefined;
      out.push({ expr: v, at: m.index });
    }
    return out;
  }
  return parameterArguments(source, before, name);
}

/** The expression starting at `from`: up to the `;`, `,` or closing bracket at depth 0, or the line end that ends it. */
function valueAt(source: string, from: number): string | null {
  let j = from;
  const end = Math.min(source.length, from + MAX_STATEMENT);
  while (j < end) {
    const c = source[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(source, j); continue; }
    if (c === "(" || c === "[" || c === "{") { j = skipBalanced(source, j); continue; }
    if (c === ";" || c === "," || c === ")" || c === "}" || c === "]") break;
    if (c === "\n") {
      const head = source.slice(from, j).trimEnd();
      const after = source.slice(j + 1, j + 200).trimStart();
      if (head.length > 0 && !/[+(,?:=]$/.test(head) && !/^[.+?:]/.test(after)) break;
    }
    j++;
  }
  if (j >= end && end < source.length) return null;
  const v = source.slice(from, j).trim();
  return v.length > 0 ? v : null;
}

/** The arguments the file's calls pass for `name`, a parameter of the function declared nearest before the statement. */
function parameterArguments(source: string, before: string, name: string): Written[] | undefined {
  const heads = [...before.matchAll(/(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?)\(/g)];
  for (let h = heads.length - 1; h >= 0; h--) {
    const head = heads[h]!;
    const open = head.index! + head[0].length - 1;
    const close = skipBalanced(source, open);
    const params = splitTop(source.slice(open + 1, close - 1), ",").map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0]);
    const index = params.indexOf(name);
    if (index < 0) continue;
    const fn = head[1] ?? head[2]!;
    const out: Written[] = [];
    const calls = new RegExp(String.raw`(?<![\w$.])${fn.replace(/\$/g, "\\$")}\s*\(`, "g");
    for (let m = calls.exec(source); m; m = calls.exec(source)) {
      const at = m.index + m[0].length - 1;
      if (at === open) continue;
      const args = splitTop(source.slice(at + 1, skipBalanced(source, at) - 1), ",");
      if (args[index] === undefined) return undefined;
      out.push({ expr: args[index]!, at });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/** Every value the file gives a member: `prop: value` in an object literal, `.prop = value`. Types (`prop: string;`) are none. */
function memberValues(source: string, prop: string): Written[] | undefined {
  const out: Written[] = [];
  const esc = prop.replace(/\$/g, "\\$");
  const writes = new RegExp(String.raw`(?:(?<![\w$.?])${esc}\s*:(?!:)|\.${esc}\s*=(?!=))\s*`, "g");
  for (let m = writes.exec(source); m; m = writes.exec(source)) {
    const v = valueAt(source, m.index + m[0].length);
    if (v === null) return undefined;
    if (TYPE_WORD.test(v)) continue;
    out.push({ expr: v, at: m.index });
  }
  return out.length > 0 ? out : undefined;
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
  const tally: Tally = { holes: 0, ok: true, outer: { source, at } };
  judgeExpr(rhs, new Map(), tally);
  if (!tally.ok || tally.holes === 0) return undefined;
  return {
    severity: "low",
    message: "innerHTML assignment whose every interpolated value passes an escaper or a number conversion. Check the escaper suits where the value lands (an attribute needs quotes escaped too).",
  };
}

/**
 * `SecurityRule.judge` for the `shell: true` rule: a process whose command and every argument are string
 * literals (`spawn("npm", ["run", "dev"], { shell: true })`, kept for Windows' `npm.cmd`) hands the shell
 * nothing anyone else wrote, so the finding is dropped. One value the call does not spell keeps it.
 */
export function judgeLiteralShellCommand(source: string, at: number): SecurityJudgement | undefined {
  const open = source.indexOf("(", at);
  if (open < 0) return undefined;
  const close = skipBalanced(source, open);
  const args = splitTop(source.slice(open + 1, close - 1), ",");
  if (args.length < 2 || !isStringLiteral(args[0]!)) return undefined;
  const list = args[1]!;
  if (!list.startsWith("[") || !spans(list)) return undefined;
  return splitTop(list.slice(1, -1), ",").every((a) => isStringLiteral(a) || (a.startsWith("`") && isTemplateLiteral(a) && !a.includes("${")))
    ? { drop: true }
    : undefined;
}
