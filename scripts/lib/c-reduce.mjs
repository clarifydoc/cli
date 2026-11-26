/**
 * The reduction behind scripts/reduce-refused-c.mjs: a C or C++ text the reader refuses cut down to a smaller text
 * it still refuses, so a person can read the cause. Pure functions over a `refused(text) -> boolean` predicate, so a
 * test can drive them with the real reader from `src/` and the script with the built one from `dist/`.
 *
 * The reader reads a conditional file as written first and, when that is refused, again with only the first live
 * branch of every `#if`/`#else` (`readWithBranches`), so a file is refused when both are. A cause spread over a
 * conditional structure (a parameter list split by `#ifdef`, each branch closing another bracket) cannot be reduced
 * while the structure stays, so the structure is settled first: `flatten` keeps one branch of every conditional and
 * leaves no `#if` behind, the text then reduces freely, and the reduction says which unit the reader first refuses.
 *
 * Configurations (`CONFIGS`): `first` (the branch the reader's second attempt reads), `second` (the other branch,
 * what an `#else` defines for another platform), `off` (the last branch, a lone `#ifdef`'s body left out: a build with no optional feature) and `asis` (every directive kept, a candidate keeps the `#if`/`#endif`
 * balance and the code's bracket depth). The flat ones drop whole branches together with their brackets.
 */

/**
 * Logical lines of a text, each `{ t: text, n: 1-based first physical line, c: the code of the line }`; a
 * backslash-newline joins the next line. `c` is the text with comments, strings and characters blanked, scanned
 * across lines, so a bracket or an apostrophe inside a block comment of several lines counts for nothing.
 */
export function logicalLines(text) {
  const raw = text.split("\n");
  const out = [];
  let inComment = false;
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    const n = i + 1;
    while (line.endsWith("\\") && i + 1 < raw.length) line += "\n" + raw[++i];
    let c = "";
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inComment) {
        if (ch === "*" && line[k + 1] === "/") (inComment = false), k++;
        continue;
      }
      if (ch === "/" && line[k + 1] === "*") (inComment = true), k++;
      else if (ch === "/" && line[k + 1] === "/") break;
      else if (ch === '"' || ch === "'") {
        let j = k + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        k = j;
        c += " ";
      } else c += ch;
    }
    out.push({ t: line, n, c });
  }
  return out;
}

export const isDirective = (l) => /^[ \t]*#/.test(l);
const directiveKind = (l) => /^[ \t]*#[ \t]*(\w+)/.exec(l)?.[1] ?? "";
const OPENS = new Set(["if", "ifdef", "ifndef"]);
const BRANCH = new Set(["else", "elif", "elifdef", "elifndef"]);

/** A condition no compiler of the language takes: `#if 0`, and `__cplusplus` as the language is C or C++. */
function deadCondition(kind, rest, cplusplus) {
  const cond = rest.trim();
  if (kind === "if" && (cond === "0" || /^\(\s*0\s*\)$/.test(cond))) return true;
  const plusplus = (term) => /^defined\s*\(?\s*__cplusplus\s*\)?$/.test(term) || term === "__cplusplus";
  const notPlusplus = (term) => /^!\s*defined\s*\(?\s*__cplusplus\s*\)?$/.test(term);
  if (kind === "ifdef") return !cplusplus && cond === "__cplusplus";
  if (kind === "ifndef") return cplusplus && cond === "__cplusplus";
  // A conjunction is dead when one of its terms is.
  return kind === "if" && cond.split("&&").some((term) => (cplusplus ? notPlusplus : plusplus)(term.trim()));
}

/**
 * The text with every conditional settled to one branch and its `#if`/`#else`/`#endif` lines gone (other directives
 * stay). `which`: `first` = the first branch no compiler rules out; `second` = the second (or the only one).
 * Returns logical lines with their original numbers.
 */
export function flatten(lines, which, cplusplus = false) {
  // Pass 1: the dead flags of every conditional, in the order they open.
  const rows = [];
  const open = [];
  for (const { t } of lines) {
    if (!isDirective(t)) continue;
    const kind = directiveKind(t);
    const rest = t.replace(/^[ \t]*#[ \t]*\w+/, "");
    if (OPENS.has(kind)) {
      const row = [deadCondition(kind, rest, cplusplus)];
      rows.push(row);
      open.push(row);
    } else if (BRANCH.has(kind) && open.length) open.at(-1).push(kind === "else" ? false : deadCondition(kind, rest, cplusplus));
    else if (kind === "endif") open.pop();
  }
  const chosen = rows.map((dead) => {
    const firstLive = Math.max(0, dead.indexOf(false));
    // `off`: the last branch when there is an `#else`, else none (a lone `#ifdef X` body is left out).
    const at = which === "off" ? (dead.length > 1 ? dead.length - 1 : -1) : which === "first" ? firstLive : dead[0] ? firstLive : Math.min(1, dead.length - 1);
    return at < 0 || dead[at] ? -1 : at; // a branch no compiler takes is left out whole
  });
  // Pass 2: keep what sits in a chosen branch of every open conditional.
  const out = [];
  const frames = [];
  let next = 0;
  for (const line of lines) {
    const kind = isDirective(line.t) ? directiveKind(line.t) : "";
    if (OPENS.has(kind)) frames.push({ at: 0, want: chosen[next++] });
    else if (BRANCH.has(kind) && frames.length) frames.at(-1).at++;
    else if (kind === "endif" && frames.length) frames.pop();
    else if (frames.every((f) => f.at === f.want)) out.push(line);
  }
  return out;
}

/** Net bracket depth of a line's code (`c`: comments and strings already blanked). */
export function netDepth(code) {
  let d = 0;
  for (const ch of code) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
  }
  return d;
}

/** `#if`/`#endif` balance of a list of lines, never negative. */
function conditionalsBalance(lines) {
  let depth = 0;
  for (const { t } of lines) {
    if (!isDirective(t)) continue;
    const k = directiveKind(t);
    if (OPENS.has(k)) depth++;
    else if (k === "endif" && --depth < 0) return false;
  }
  return depth === 0;
}

const join = (lines) => lines.map((l) => l.t).join("\n");
/** Net bracket depth of the code lines, directives left out. */
export const codeNet = (ls) => ls.reduce((n, l) => (isDirective(l.t) ? n : n + netDepth(l.c)), 0);

const endsStatement = (l) => /[;}]\s*(\/\/.*|\/\*.*\*\/)?\s*$/.test(l);
function startsStatement(ls, i) {
  for (let k = i - 1; k >= 0; k--) {
    const l = ls[k].t;
    if (l.trim() === "") continue;
    return isDirective(l) || /[;{}:]\s*(\/\/.*|\/\*.*\*\/)?\s*$/.test(l) || /\*\/\s*$/.test(l);
  }
  return true;
}

/**
 * Units: a directive line, or a top-level declaration or definition. A unit starts at a line in column 0 that follows
 * the end of a statement or a directive.
 */
export function units(ls) {
  const out = [];
  let cur = [];
  const flush = () => cur.length && (out.push(cur), (cur = []));
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (isDirective(l.t)) {
      flush();
      out.push([l]);
      continue;
    }
    if (/^[A-Za-z_]/.test(l.t) && startsStatement(ls, i)) flush();
    cur.push(l);
  }
  flush();
  return out;
}

/** Delta debugging: the smallest sublist `test` still accepts, removing chunks. */
export function ddmin(list, test) {
  let n = 2;
  while (list.length >= 2) {
    const size = Math.ceil(list.length / n);
    let reduced = false;
    for (let start = 0; start < list.length; start += size) {
      const rest = [...list.slice(0, start), ...list.slice(start + size)];
      if (rest.length && test(rest)) {
        list = rest;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= list.length) break;
      n = Math.min(n * 2, list.length);
    }
  }
  // a last single removal each, which the chunking can skip
  for (let i = 0; i < list.length; ) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    if (rest.length && test(rest)) list = rest;
    else i++;
  }
  return list;
}

/** Whole statements of `ls`, one by one, while `test` accepts the rest; never a line from the middle of one. */
export function lineSweep(ls, test) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ls.length; i++) {
      if (isDirective(ls[i].t) || ls[i].t.trim() === "" || !startsStatement(ls, i)) continue;
      let depth = 0;
      let j = i;
      for (; j < ls.length; j++) {
        if (isDirective(ls[j].t)) break;
        depth += netDepth(ls[j].c);
        if (depth <= 0 && endsStatement(ls[j].t)) break;
      }
      if (j >= ls.length || isDirective(ls[j].t) || depth !== 0 || !endsStatement(ls[j].t)) continue;
      const cand = [...ls.slice(0, i), ...ls.slice(j + 1)];
      if (test(cand)) {
        ls = cand;
        changed = true;
        i--;
      }
    }
  }
  return ls;
}

/**
 * Single lines that stand alone at bracket depth 0 and close their own brackets (`NAME`, `NAME(args)` with no `;`:
 * a macro used as a statement, which `lineSweep` leaves alone since nothing ends it), one by one.
 */
export function macroLineSweep(ls, test) {
  for (let i = 0; i < ls.length; ) {
    const t = ls[i].t;
    let depth = 0;
    for (let k = 0; k < i; k++) if (!isDirective(ls[k].t)) depth += netDepth(ls[k].c);
    const lone = !isDirective(t) && depth === 0 && /^[A-Za-z_]\w*\s*(\(.*\))?\s*(\/\/.*|\/\*.*\*\/)?$/.test(t.trim()) && netDepth(ls[i].c) === 0;
    const cand = lone ? [...ls.slice(0, i), ...ls.slice(i + 1)] : null;
    if (cand && test(cand)) ls = cand;
    else i++;
  }
  return ls;
}

/** Directive lines one by one, a conditional through its `#endif` as a whole with what is under it. */
function directiveSweep(ls, test) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ls.length; i++) {
      if (!isDirective(ls[i].t)) continue;
      const kind = directiveKind(ls[i].t);
      let cand;
      if (OPENS.has(kind)) {
        let depth = 0;
        let end = -1;
        for (let j = i; j < ls.length; j++) {
          const k = isDirective(ls[j].t) ? directiveKind(ls[j].t) : "";
          if (OPENS.has(k)) depth++;
          else if (k === "endif" && --depth === 0) {
            end = j;
            break;
          }
        }
        if (end < 0) continue;
        cand = [...ls.slice(0, i), ...ls.slice(end + 1)];
      } else if (kind === "endif" || BRANCH.has(kind)) continue;
      else cand = ls.filter((_, j) => j !== i);
      if (test(cand)) {
        ls = cand;
        changed = true;
        i--;
      }
    }
  }
  return ls;
}

/**
 * Reduces a conditional-free text. The reader's first refusal is placed at unit granularity: the smallest prefix of
 * whole top-level units (cut where the brackets are closed) it refuses; its last unit `L` is the cause's home, the
 * units before it the context (macros, types) it needs. Context is reduced with `L` kept and a requirement that the
 * context alone is still read, so a stump (a context cut short) is never taken for a cause; then `L`'s statements.
 */
function reduceFlat(ls, refused, notes) {
  const us = units(ls);
  const prefix = (k) => us.slice(0, k + 1).flat();
  const closed = us.map((_, k) => codeNet(prefix(k)) === 0);
  let lo = 0;
  let hi = us.length - 1;
  // smallest k with a closed prefix refused; closed prefixes only (an open one is refused for its own reason)
  const ks = us.map((_, k) => k).filter((k) => closed[k]);
  let k = us.length - 1;
  if (ks.length) {
    lo = 0;
    hi = ks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (refused(join(prefix(ks[mid])))) hi = mid;
      else lo = mid + 1;
    }
    if (refused(join(prefix(ks[lo])))) k = ks[lo];
  }
  const last = us[k];
  notes.push(`the reader first refuses the unit at line ${last[0].n} of the file (${last.length} line${last.length > 1 ? "s" : ""}), after ${k} units it reads`);
  let context = us.slice(0, k);
  const ctxLines = (c) => c.flat();
  const whole = (c, l) => [...ctxLines(c), ...l];
  const contextOk = (c) => !refused(join(ctxLines(c)));
  const accept = (c, l) => codeNet(whole(c, l)) === codeNet(prefix(k)) && refused(join(whole(c, l))) && (c.length === 0 || contextOk(c));
  let body = last;
  for (let round = 0; round < 2; round++) {
    context = ddmin(context, (c) => accept(c, body));
    body = lineSweep(body, (l) => accept(context, l));
    body = body.length ? body : last;
  }
  // Last, the statements inside the units left (a function body of the context) and the directives, on the whole text.
  const all = [...ctxLines(context), ...body];
  const net = codeNet(prefix(k)); // the depth the cut text had, not the reduced one's
  const whole2 = (cand) => codeNet(cand) === net && refused(join(cand));
  const cut = lineSweep(directiveSweep(macroLineSweep(lineSweep(all, whole2), whole2), whole2), whole2);
  return { lines: cut, line: last[0].n };
}

/** The old reduction: every directive kept; a candidate keeps the conditional balance and the code's bracket depth. */
function reduceAsIs(ls, refused) {
  const want = codeNet(ls);
  const test = (c) => conditionalsBalance(c) && codeNet(c) === want && refused(join(c));
  const us = units(ls);
  const dirs = new Map(us.map((u, i) => [i, u]).filter(([, u]) => u.length === 1 && isDirective(u[0].t)));
  const codeIdx = us.map((_, i) => i).filter((i) => !dirs.has(i));
  const build = (idx) => us.flatMap((u, i) => (dirs.has(i) || idx.includes(i) ? u : []));
  let out = build(ddmin(codeIdx, (idx) => test(build(idx))));
  out = lineSweep(out, test);
  out = directiveSweep(out, test);
  return lineSweep(out, test);
}

export const CONFIGS = ["first", "second", "off", "asis"];

/**
 * Reduces `text` under each configuration the reader refuses it in. Returns `{ results, best }`; a result is
 * `{ config, text, line, notes, reads }` (`line`: where the reader first refuses, flat configurations only) or
 * `{ config, skipped }` when that configuration is not refused (the cause then is in another).
 */
export function reduceRefused(text, refusedRaw, { configs = CONFIGS, cplusplus = false, maxReads = 4000 } = {}) {
  let reads = 0;
  const cache = new Map();
  const refused = (t) => {
    if (cache.has(t)) return cache.get(t);
    if (++reads > maxReads) throw new Error(`more than ${maxReads} reads; raise --max-reads`);
    let r;
    try {
      r = refusedRaw(t);
    } catch {
      r = false;
    }
    cache.set(t, r);
    return r;
  };
  if (!refused(text)) return { results: [], best: null, notRefused: true };
  const lines = logicalLines(text);
  const results = [];
  for (const config of configs) {
    const before = reads;
    const notes = [];
    let ls = config === "asis" ? lines : flatten(lines, config, cplusplus);
    if (!refused(join(ls))) {
      results.push({ config, skipped: "the reader reads this configuration" });
      continue;
    }
    let line;
    if (config === "asis") ls = reduceAsIs(ls, refused);
    else ({ lines: ls, line } = reduceFlat(ls, refused, notes));
    const out = join(ls).replace(/\n{3,}/g, "\n\n") + "\n";
    if (!refused(out)) throw new Error("internal: the reduced text is no longer refused");
    results.push({ config, text: out, line, notes, reads: reads - before });
  }
  const done = results.filter((r) => r.text);
  const best = done.length ? done.reduce((a, b) => (b.text.length < a.text.length ? b : a)) : null;
  return { results, best };
}
