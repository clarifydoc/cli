#!/usr/bin/env node
// Fails on the regular-expression shapes the repository's code scanning (CodeQL) reports, before a push does:
//
//  1. escape  — a hand-rolled escape of text built into a pattern (`name.replace(/\$/g, "\\$")`) that escapes some
//               metacharacters and leaves others (a backslash first). Use `escapeRegex` from
//               src/extractors/plugins/shared/path-utils.ts, the one function allowed to write such a replace.
//  2. nested  — a repeated group with a run inside that can swallow a whole iteration of the group and is not stopped
//               by what follows it (`(?:\s+as\s+[^()]+?)*`, `(?:…|\.x\([\s\S]*\))*`, `(\w+\s?)*`; not `(?:"[^"]*"|x)*`,
//               whose run ends at a quote): two ways to split the same text, so a failing match backtracks exponentially. Make the inner run stop at a character the group needs
//               (`[^,]+` before a `,`), or take the repeated part out of the group.
//  3. comment — an HTML comment matched (`<!--…-->`) or its end checked (`\*\/|-->`) as `-->` only: an HTML comment
//               also ends at `--!>`, so write `--!?>`.
//
// Every regex literal and every `RegExp(…)` / `new RegExp(…)` built from string literals, templates (a `${…}` reads
// as one letter) and `+` of them is read with tree-sitter's TypeScript grammar, tests included. The nested rule is a heuristic:
// it reasons about what each part can match over a sample of characters, and it does not see polynomial
// (quadratic) shapes — code scanning still runs on every push, and its alerts are read after it.
// A shape kept on purpose goes in scripts/regex-safety-allow.json as { "<file>:<rule>:<pattern>": "reason" }.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = process.argv[2] ?? join(root, "src");
const allowPath = process.argv[3] ?? join(root, "scripts", "regex-safety-allow.json");
const ESCAPE_HOME = join("extractors", "plugins", "shared", "path-utils.ts");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) yield* walk(p);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) yield p;
  }
}

// ── A small reader of JavaScript regex syntax: sets of characters over a sample alphabet, groups, quantifiers ──

const SAMPLE = [];
for (let c = 0x20; c < 0x7f; c++) SAMPLE.push(String.fromCharCode(c));
SAMPLE.push("\t", "\n", "\r", "é", "中");
const ALL = new Set(SAMPLE);
const setOf = (pred) => new Set(SAMPLE.filter(pred));
const CLASS = {
  d: setOf((c) => /\d/.test(c)), D: setOf((c) => /\D/.test(c)),
  w: setOf((c) => /\w/.test(c)), W: setOf((c) => /\W/.test(c)),
  s: setOf((c) => /\s/.test(c)), S: setOf((c) => /\S/.test(c)),
};

/** The node tree of `source`: { alts: [[node]] }, node = { kind: "set", set } | { kind: "group", alts } with min/max. */
function parseRegex(source, flags = "") {
  let i = 0;
  const dotAll = flags.includes("s");
  const ignoreCase = flags.includes("i");
  const lit = (ch) => (ignoreCase ? setOf((c) => c.toLowerCase() === ch.toLowerCase()) : new Set(ALL.has(ch) ? [ch] : []));

  function escapeAt() {
    // at a backslash outside a class: returns { set } or null for a zero-width escape
    const ch = source[i + 1];
    i += 2;
    if (ch === undefined) return { set: new Set() };
    if (CLASS[ch]) return { set: CLASS[ch] };
    if (ch === "b" || ch === "B") return { assert: true };
    if (/[1-9]/.test(ch)) { while (/\d/.test(source[i] ?? "")) i++; return null; }
    if (ch === "k" && source[i] === "<") { i = source.indexOf(">", i) + 1 || source.length; return null; }
    if (ch === "p" || ch === "P") { if (source[i] === "{") i = source.indexOf("}", i) + 1 || source.length; return { set: CLASS.w }; }
    if (ch === "u") { const m = /^\{[0-9a-fA-F]+\}|^[0-9a-fA-F]{4}/.exec(source.slice(i)); const hex = m ? m[0].replace(/[{}]/g, "") : ""; if (m) i += m[0].length; return { set: lit(String.fromCodePoint(parseInt(hex || "0", 16))) }; }
    if (ch === "x") { const hex = source.slice(i, i + 2); i += 2; return { set: lit(String.fromCharCode(parseInt(hex, 16) || 0)) }; }
    if (ch === "c") { i++; return { set: new Set() }; }
    const named = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", 0: "\0" }[ch];
    return { set: lit(named ?? ch) };
  }

  function classAt() {
    // at `[`: a character class
    i++;
    let negate = false;
    if (source[i] === "^") { negate = true; i++; }
    const members = new Set();
    let first = true;
    while (i < source.length && (source[i] !== "]" || first)) {
      first = false;
      let from;
      if (source[i] === "\\") {
        const ch = source[i + 1];
        if (CLASS[ch]) { for (const c of CLASS[ch]) members.add(c); i += 2; continue; }
        const e = escapeAt();
        from = e ? [...e.set][0] : undefined;
        if (!e || from === undefined) continue;
      } else from = source[i++];
      if (source[i] === "-" && source[i + 1] !== "]" && i + 1 < source.length) {
        i++;
        let to;
        if (source[i] === "\\") { const e = escapeAt(); to = e ? [...e.set][0] : from; } else to = source[i++];
        for (const c of SAMPLE) if (c >= from && c <= (to ?? from)) members.add(c);
        if (ignoreCase) for (const c of SAMPLE) if (c.toLowerCase() >= from.toLowerCase() && c.toLowerCase() <= (to ?? from).toLowerCase()) members.add(c);
      } else for (const c of lit(from)) members.add(c);
    }
    i++; // the `]`
    return negate ? setOf((c) => !members.has(c)) : members;
  }

  function quantifierAt(node) {
    const q = /^(?:\*|\+|\?|\{(\d+)(?:(,)(\d*))?\})\??/.exec(source.slice(i));
    if (!q) return node;
    i += q[0].length;
    const head = q[0][0];
    if (head === "*") return { ...node, min: 0, max: Infinity };
    if (head === "+") return { ...node, min: 1, max: Infinity };
    if (head === "?") return { ...node, min: 0, max: 1 };
    const min = Number(q[1]);
    return { ...node, min, max: q[2] ? (q[3] ? Number(q[3]) : Infinity) : min };
  }

  function alternatives() {
    const alts = [[]];
    while (i < source.length && source[i] !== ")") {
      const ch = source[i];
      if (ch === "|") { alts.push([]); i++; continue; }
      let node = null;
      if (ch === "(") {
        const look = /^\(\?(?:[=!]|<[=!])/.exec(source.slice(i));
        if (look) { i += look[0].length; alternatives(); i++; alts[alts.length - 1].push(quantifierAt({ kind: "assert", min: 1, max: 1 })); continue; }
        const head = /^\(\?(?::|<[A-Za-z_$][\w$]*>)?|^\(/.exec(source.slice(i));
        i += head[0].length;
        const inner = alternatives();
        i++; // the `)`
        node = { kind: "group", alts: inner, min: 1, max: 1 };
      } else if (ch === "[") node = { kind: "set", set: classAt(), min: 1, max: 1 };
      else if (ch === "\\") { const e = escapeAt(); if (!e) { quantifierAt({}); continue; } node = e.assert ? { kind: "assert", min: 1, max: 1 } : { kind: "set", set: e.set, min: 1, max: 1 }; }
      else if (ch === "^" || ch === "$") { i++; node = { kind: "assert", min: 1, max: 1 }; }
      else if (ch === ".") { i++; node = { kind: "set", set: dotAll ? ALL : setOf((c) => c !== "\n" && c !== "\r"), min: 1, max: 1 }; }
      else { i++; node = { kind: "set", set: lit(ch), min: 1, max: 1 }; }
      alts[alts.length - 1].push(quantifierAt(node));
    }
    return alts;
  }

  return { alts: alternatives() };
}

const covers = (outer, inner) => [...inner].every((c) => outer.has(c));

/** Whether the run `b` can match a whole iteration of `alt`: every part the iteration must match is inside b's set. */
function swallows(alt, b) {
  let mandatory = 0;
  for (const n of alt) {
    if (n.min === 0 || n.kind === "assert") continue;
    mandatory++;
    if (n.kind === "set" ? !covers(b.set, n.set) : !n.alts.some((a) => swallows(a, b))) return false;
  }
  return mandatory > 0;
}

/** Whether `b` can also match everything `tail` must match: a run that can, can carry on into the next iteration. */
function passesOver(tail, b) {
  for (const n of tail) {
    if (n.min === 0 || n.kind === "assert") continue;
    if (n.kind === "set" ? !covers(b.set, n.set) : !n.alts.some((a) => passesOver(a, b))) return false;
  }
  return true;
}

/** Each unbounded run inside `alts`, with what its own iteration still needs after it (inner tails first). */
function* runsWithTails(alts, outerTail) {
  for (const alt of alts)
    for (let k = 0; k < alt.length; k++) {
      const n = alt[k];
      const tail = [...alt.slice(k + 1), ...outerTail];
      if (n.kind === "set" && n.max === Infinity && n.set.size > 0) yield { b: n, tail };
      if (n.kind === "group") yield* runsWithTails(n.alts, tail);
    }
}

/**
 * A repeated group with an unbounded run inside that can swallow one of the group's whole iterations and is not
 * stopped by what follows it: the same text then splits into iterations in more ways than one.
 */
function nestedRepetition(tree) {
  // Only a group something after it can still reject: at the very end of a pattern the first way through succeeds.
  const canFail = (tail) => tail.some((n) => n.min > 0 && (n.kind !== "group" || n.alts.every((a) => canFail(a))));
  const visit = (alts, outerTail) => {
    for (const alt of alts)
      for (let k = 0; k < alt.length; k++) {
        const n = alt[k];
        if (n.kind !== "group") continue;
        const after = [...alt.slice(k + 1), ...outerTail];
        if (n.max === Infinity && canFail(after)) {
          for (const { b, tail } of runsWithTails(n.alts, [])) if (passesOver(tail, b) && n.alts.some((a) => swallows(a, b))) return true;
        }
        if (visit(n.alts, after)) return true;
      }
    return false;
  };
  return visit(tree.alts, []);
}

// ── Reading the sources ──

const grammar = createRequire(import.meta.url).resolve("tree-sitter-typescript/tree-sitter-typescript.wasm");
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(grammar));

/** A string literal's value: the escapes a pattern can hold, read as JavaScript reads them. */
function cook(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, e) => {
    if (e[0] === "u") return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16));
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" }[e] ?? (e.includes("\n") ? "" : e);
  });
}

/** A template's text, a `${…}` read as `X`; raw for `String.raw`. */
function templateText(node, raw) {
  let text = "";
  let at = node.startIndex + 1;
  for (const c of node.namedChildren) {
    if (c.type !== "template_substitution") continue;
    const part = node.tree.rootNode.text.slice(at, c.startIndex);
    text += (raw ? part : cook(part)) + "X";
    at = c.endIndex;
  }
  const tail = node.tree.rootNode.text.slice(at, node.endIndex - 1);
  return text + (raw ? tail : cook(tail));
}

/** The text of a pattern built from literals: strings, templates and `+` of them; null for anything else. */
function literalText(node) {
  if (!node) return null;
  if (node.type === "string") return cook(node.text.slice(1, -1));
  if (node.type === "template_string") return templateText(node, false);
  if (node.type === "call_expression" && node.childForFieldName("function")?.text === "String.raw") {
    const t = node.childForFieldName("arguments");
    return t?.type === "template_string" ? templateText(t, true) : null;
  }
  if (node.type === "parenthesized_expression") return literalText(node.namedChildren[0]);
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const l = literalText(node.childForFieldName("left"));
    const r = literalText(node.childForFieldName("right"));
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

/**
 * An escape that leaves the backslash itself unescaped, or replaces only the first match (no `g`): what it escapes
 * can then be undone by a backslash in the input. An escape that leaves `*` or `?` out on purpose (a glob turned into
 * a pattern) is fine.
 */
function partialEscape(regexNode) {
  const source = regexNode.childForFieldName("pattern")?.text ?? "";
  const flags = regexNode.childForFieldName("flags")?.text ?? "";
  if (!flags.includes("g")) return true;
  let tree;
  try { tree = parseRegex(source, flags); } catch { return true; }
  const escapesBackslash = (alts) => alts.some((alt) => alt.some((n) => (n.kind === "set" && n.set.has("\\")) || (n.kind === "group" && escapesBackslash(n.alts))));
  return !escapesBackslash(tree.alts);
}

function check(file, text) {
  const tree = parser.parse(text);
  const found = [];
  const judge = (node, source, flags) => {
    const line = node.startPosition.row + 1;
    // An HTML comment matcher (`<!--`) or a comment-end check beside `*/`; a Mermaid or Raku `-->` arrow is no comment.
    if (/-->/.test(source) && /<!--|\\\*\\\//.test(source)) found.push({ line, rule: "comment", pattern: source });
    let parsed;
    try { parsed = parseRegex(source, flags); } catch { return; }
    if (nestedRepetition(parsed)) found.push({ line, rule: "nested", pattern: source });
  };
  const stack = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "regex") {
      judge(node, node.childForFieldName("pattern")?.text ?? "", node.childForFieldName("flags")?.text ?? "");
    } else if ((node.type === "new_expression" && node.childForFieldName("constructor")?.text === "RegExp") ||
               (node.type === "call_expression" && node.childForFieldName("function")?.text === "RegExp")) {
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const source = literalText(args[0]);
      const flags = args[1]?.type === "string" ? cook(args[1].text.slice(1, -1)) : "";
      if (source !== null) judge(node, source, flags);
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const name = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
      const [pattern, replacement] = node.childForFieldName("arguments")?.namedChildren ?? [];
      if ((name === "replace" || name === "replaceAll") && pattern?.type === "regex" && replacement?.type === "string" &&
          cook(replacement.text.slice(1, -1)).startsWith("\\$") && !file.endsWith(ESCAPE_HOME) && partialEscape(pattern))
        found.push({ line: node.startPosition.row + 1, rule: "escape", pattern: pattern.text });
    }
    for (let k = node.namedChildCount - 1; k >= 0; k--) stack.push(node.namedChild(k));
  }
  tree.delete();
  return found;
}

const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : {};
const problems = [];
let regexFiles = 0;
for (const file of walk(srcDir)) {
  const text = readFileSync(file, "utf8");
  if (!/\/|RegExp/.test(text)) continue;
  regexFiles++;
  const rel = relative(srcDir, file).split(sep).join("/");
  for (const f of check(file, text)) if (!allow[`${rel}:${f.rule}:${f.pattern}`]) problems.push({ rel, ...f });
}
const ADVICE = {
  escape: "a hand-rolled escape leaves other metacharacters (a backslash first): use escapeRegex (plugins/shared/path-utils.ts)",
  nested: "a repeated group holds a run that can swallow a whole iteration: exponential backtracking on a failing match",
  comment: "an HTML comment also ends at `--!>`: write `--!?>`",
};
if (problems.length) {
  for (const p of problems) console.error(`${p.rel}:${p.line}  ${p.rule}  ${p.pattern.length > 120 ? p.pattern.slice(0, 117) + "…" : p.pattern}\n    ${ADVICE[p.rule]}\n    allow key: ${JSON.stringify(`${p.rel}:${p.rule}:${p.pattern}`)}`);
  console.error(`\nregex safety: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`regex safety: no unsafe shape (${regexFiles} files)`);
