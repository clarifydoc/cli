/**
 * The first sentence of the comment that documents a function or class —
 * `FunctionInfo.doc` / `ClassInfo.doc`. Read from the source as written: the
 * comment block just above the declaration (decorators and attributes may sit
 * between) or, where the language says so, the docstring that opens its body.
 * The language's shape comes from its plugin's manifest (`docComments`); core knows no
 * comment syntax of its own.
 *
 * Kept short on purpose: a first sentence, capped. It says what a function is
 * FOR, which no name or call list says, and it is what a search for the
 * purpose rather than the name finds. Tags (`@param`), licence headers,
 * directives (`eslint-disable`) and commented-out code are not documentation.
 */
import type { ClassInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { DocCommentSpec } from "../types/language-plugin.js";

/** Longest doc kept, in characters. */
export const MAX_DOC_LENGTH = 200;

export const LICENCE = /\b(?:copyright|licen[cs]ed?|spdx-license|all rights reserved)\b/i;
const DIRECTIVE = /^(?:frozen_string_literal|typed:|(?:en)?coding[:=]|@generated|auto-?generated|do not edit|go:\w|\+build|eslint|prettier|istanbul|tslint|@ts-|ts-|noqa|type:\s*ignore|pylint|rubocop|region\b|endregion\b|#region|nolint|nosec|todo\b|fixme\b|hack\b|xxx\b|-\*-|<reference\b)/i;
const TAG = /^(?:@\w|:(?:param|returns?|raises?|type|rtype)\b|\\(?:param|return)\b|<(?:param|typeparam|returns?|remarks|exception|example)\b|(?:Args|Arguments|Returns|Raises|Parameters|Example|Examples):$)/i;
/** C#'s summary wrapper and Doxygen's brief marker: around the text, not the end of it. */
const WRAPPER = /<\/?summary>|\\brief\s*/gi;
/** A line that reads as code, not prose: ends in `;`, `{` or `}`, or opens with a keyword and a symbol. */
const CODE_LINE = /(?:[;{}]\s*$)|^(?:import|export|const|let|var|return|if|for|while|def|fn|func|function|class|public|private)\b[^.]*[=({]/;

/** Attach `doc` to every function, class and method the comments of `source` document. */
export function attachDocComments(analysis: FileAnalysis, source: string, spec: DocCommentSpec | undefined): void {
  if (!spec || analysis.functions.length + analysis.classes.length === 0) return;
  if (!/\/\/|\/\*|#|--|"""|'''|\(\*|\{|;|%|!|::|=cut|\brem\b/i.test(source)) return;
  const lines = source.split(/\r?\n/);
  const attach = (item: FunctionInfo | ClassInfo): void => {
    if (!item.line || item.line < 1 || item.line > lines.length) return;
    const inner = spec.moduleDocInside && "methods" in item ? moduleDocInside(lines, item.line - 1) : null;
    const doc = (spec.docstring ? docstringBelow(lines, item.line - 1) : null) ?? inner ?? commentAbove(lines, item.line - 1, spec);
    if (doc) item.doc = doc;
  };
  for (const fn of analysis.functions) if (!fn.name.startsWith("<")) attach(fn);
  for (const cls of analysis.classes) {
    attach(cls);
    for (const m of cls.methods ?? []) attach(m);
  }
}

/** The comment block ending just above line `at` (0-based), decorators skipped. */
function commentAbove(lines: readonly string[], at: number, spec: DocCommentSpec): string | null {
  let i = at - 1;
  // A decorator or attribute between the comment and the declaration belongs to the declaration.
  // A decorator whose arguments spread over rows (`@ApiResponse({` … `})`) is skipped whole.
  const isAttribute = (t: string): boolean => !!spec.attribute?.test(t);
  for (;;) {
    if (i >= 0 && isAttribute(lines[i]!)) { i--; continue; }
    const opener = i >= 0 ? attributeOpening(lines, i, isAttribute) : -1;
    if (opener < 0) break;
    i = opener - 1;
  }
  // The declaration line may itself carry the decorators (`@Get() handler()`); the comment is still above.
  if (i < 0) return null;
  // POD is usually followed by a blank row before the sub it documents.
  if (spec.pod && !lines[i]!.trim()) {
    let k = i;
    while (k > 0 && !lines[k]!.trim()) k--;
    if (lines[k]!.trim() === "=cut") i = k;
  }
  const last = lines[i]!.trim();
  for (const [open, close] of spec.block ?? []) {
    if (!last.endsWith(close)) continue;
    const body: string[] = [];
    for (let j = i; j >= 0 && i - j < 80; j--) {
      const t = lines[j]!.trim();
      const start = t.indexOf(open);
      if (start >= 0 && (j < i || start + open.length <= t.length - close.length)) {
        body.unshift(t.slice(start + open.length));
        // A block that opens after code on its line (`x = 1; /* … */`) documents nothing.
        if (start > 0 && !/^\s*$/.test(t.slice(0, start)) && !spec.blockLead?.test(t.slice(0, start))) return null;
        const text = body.join("\n");
        return clean(text.slice(0, text.lastIndexOf(close)).split("\n").map((l) => l.replace(/^\s*\*(?!\))\s?/, "")));
      }
      body.unshift(t);
    }
    // Not this block's opener (`/*` rather than `/**`): try the next shape.
  }
  if (spec.pod && last === "=cut") {
    const top = podTop(lines, i);
    return top < 0 ? null : clean(lines.slice(top + 1, i));
  }
  if ((spec.block ?? []).some(([, close]) => last.endsWith(close))) return null;
  const starts = (t: string, p: string) => (spec.caseInsensitive ? t.toLowerCase().startsWith(p.toLowerCase()) : t.startsWith(p));
  const prefix = (spec.line ?? []).find((p) => starts(last, p));
  if (!prefix) return null;
  const body: string[] = [];
  for (let j = i; j >= 0; j--) {
    const t = lines[j]!.trim();
    if (!starts(t, prefix)) break;
    body.unshift(t.slice(prefix.length));
  }
  return clean(body);
}

/** Elixir's `@moduledoc """ … """` (or `@moduledoc "…"`) opening the body of the module declared at row `at` (0-based). */
function moduleDocInside(lines: readonly string[], at: number): string | null {
  let k = at + 1;
  while (k < lines.length && k < at + 6 && !lines[k]!.trim()) k++;
  const m = /^\s*@moduledoc\s+(?:~[sS])?("""|")(.*)$/.exec(lines[k] ?? "");
  if (!m) return null;
  const q = m[1]!;
  const end = m[2]!.indexOf(q);
  if (end >= 0) return clean([m[2]!.slice(0, end)]);
  if (q === '"') return null;
  const body = [m[2]!];
  for (let n = k + 1; n < lines.length && n < k + 80; n++) {
    const close = lines[n]!.indexOf(q);
    if (close >= 0) {
      body.push(lines[n]!.slice(0, close));
      return clean(body);
    }
    body.push(lines[n]!);
  }
  return null;
}

/** The row (0-based) of the POD command (`=head2`, `=pod`, `=item`) opening the block that `=cut` closes on row `cut`; -1 when none. */
function podTop(lines: readonly string[], cut: number): number {
  for (let j = cut - 1; j >= 0 && cut - j < 120; j--) {
    const t = lines[j]!;
    if (/^=(?:head\d|pod|item|over|back|begin|for)\b/.test(t)) return j;
    if (/^=cut\b/.test(t)) return -1;
  }
  return -1;
}

/** The docstring opening the body of the declaration at line `at` (0-based): the first statement after its header. */
function docstringBelow(lines: readonly string[], at: number): string | null {
  // The header ends at the first line ending in `:` (outside a parameter list spread over lines).
  let depth = 0;
  let j = at;
  for (; j < lines.length && j < at + 40; j++) {
    const code = lines[j]!.replace(/#.*$/, "");
    for (const ch of code) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
    }
    if (depth <= 0 && /:\s*$/.test(code)) break;
  }
  let k = j + 1;
  while (k < lines.length && lines[k]!.trim() === "") k++;
  if (k >= lines.length) return null;
  const first = lines[k]!.trim();
  const m = /^[rRuUbB]?("""|'''|"|')/.exec(first);
  if (!m) return null;
  const q = m[1]!;
  const rest = first.slice(m[0].length);
  const end = rest.indexOf(q);
  if (end >= 0) return clean([rest.slice(0, end)]);
  const body = [rest];
  for (let n = k + 1; n < lines.length && n < k + 80; n++) {
    const t = lines[n]!;
    const close = t.indexOf(q);
    if (close >= 0) {
      body.push(t.slice(0, close));
      return clean(body);
    }
    body.push(t);
  }
  return null;
}

/** A comment's first sentence: tags, directives, licences and code dropped; capped. */
function clean(raw: readonly string[]): string | null {
  const para: string[] = [];
  for (const line of raw) {
    const t = line.replace(/^\s*[*#!/]*\s?/, "").replace(/\s*\*+\/?\s*$/, "").replace(WRAPPER, "").trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    // Comment-based help (PowerShell) heads its text with a keyword line.
    if (/^\.(?:SYNOPSIS|DESCRIPTION)$/i.test(t)) continue;
    if (TAG.test(t) || /^\.(?:PARAMETER|EXAMPLE|NOTES|LINK|INPUTS|OUTPUTS)\b/i.test(t)) break;
    para.push(t);
  }
  let text = para.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 3 || LICENCE.test(text) || DIRECTIVE.test(text) || CODE_LINE.test(text)) return null;
  // XML doc tags (`<summary>`) wrap a C# comment's text; inline markup keeps its words.
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<\/?[a-z]+[^>]*>/gi, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(text)) return null;
  const sentence = /^(.{12,}?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  if (sentence.length <= MAX_DOC_LENGTH) return sentence;
  const cut = sentence.slice(0, MAX_DOC_LENGTH - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_DOC_LENGTH / 2))}…`;
}

/** Rows a decorator spread over lines (`@ApiResponse({` … `})`) may take, read upward from its last line. */
const MAX_ATTRIBUTE_ROWS = 15;
/** The sigil a decorator, annotation or attribute line opens with: `@Get`, `#[cfg`, `[HttpGet`, `<Route`. */
const ATTRIBUTE_SIGIL = /^\s*(?:@|#!?\[|\[|<)\s*([A-Za-z_$][\w.:$]*)/;

/**
 * The first line (1-based) of the declaration at `line` with its head: the decorators, attributes and
 * annotations above it, and the doc comment the analysis read its `doc` from — what a snippet of the
 * declaration starts at, so `@Get() @UseGuards(CoachGuard)`, `#[cfg(not(…))]` and `@app.get("/clubs")` are
 * quoted with it. Only lines the declaration accounts for are taken: a line the language's attribute shape
 * matches, one opening with a decorator the item lists (and the rows of its arguments), and the comment block
 * whose words begin its `doc`. A blank line ends the head.
 */
export function declarationHeadLine(
  lines: readonly string[],
  line: number,
  spec: DocCommentSpec | undefined,
  item: { decorators?: readonly string[]; doc?: string },
): number {
  const names = new Set((item.decorators ?? []).map((d) => /^\s*(?:@|#!?\[|\[|<)?\s*([A-Za-z_$][\w.:$]*)/.exec(d)?.[1]).filter((n): n is string => !!n));
  const isAttribute = (t: string): boolean => !!spec?.attribute?.test(t) || (names.size > 0 && names.has(ATTRIBUTE_SIGIL.exec(t)?.[1] ?? ""));
  let start = line;
  let docTaken = !item.doc;
  let i = line - 2;
  while (i >= 0) {
    const t = lines[i]!;
    if (!t.trim()) break;
    if (isAttribute(t)) {
      start = i + 1;
      i--;
      continue;
    }
    const opener = attributeOpening(lines, i, isAttribute);
    if (opener >= 0) {
      start = opener + 1;
      i = opener - 1;
      continue;
    }
    if (!docTaken) {
      const top = commentTop(lines, i, spec);
      if (top >= 0 && startsWithDoc(lines.slice(top, i + 1), item.doc!)) {
        start = top + 1;
        i = top - 1;
        docTaken = true;
        continue;
      }
    }
    break;
  }
  return start;
}

/** The decorator line whose argument list, spread over rows, closes on row `end` (0-based); -1 when none. */
function attributeOpening(lines: readonly string[], end: number, isAttribute: (t: string) => boolean): number {
  for (let k = end - 1; k >= 0 && end - k <= MAX_ATTRIBUTE_ROWS; k--) {
    if (!lines[k]!.trim()) return -1;
    if (!isAttribute(lines[k]!)) continue;
    let depth = 0;
    for (let r = k; r <= end; r++) {
      depth += bracketDelta(lines[r]!);
      // Open until its last row, closed there.
      if (r < end ? depth <= 0 : depth !== 0) break;
      if (r === end) return k;
    }
    return -1;
  }
  return -1;
}

/** Opening minus closing brackets on a row, quoted text left out. */
function bracketDelta(row: string): number {
  let d = 0;
  for (const ch of row.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "")) {
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") d--;
  }
  return d;
}

/** The first row (0-based) of the comment ending on row `end`, in the language's comment shapes; -1 when row `end` ends none. */
function commentTop(lines: readonly string[], end: number, spec: DocCommentSpec | undefined): number {
  if (!spec) return -1;
  const last = lines[end]!.trim();
  for (const [open, close] of spec.block ?? []) {
    if (!last.endsWith(close)) continue;
    for (let j = end; j >= 0 && end - j < 80; j--) {
      const t = lines[j]!.trim();
      const at = t.indexOf(open);
      if (at >= 0 && (j < end || at + open.length <= last.length - close.length)) return at === 0 || !!spec.blockLead?.test(t.slice(0, at)) ? j : -1;
    }
  }
  if (spec.pod && last === "=cut") return podTop(lines, end);
  const starts = (t: string, p: string) => (spec.caseInsensitive ? t.toLowerCase().startsWith(p.toLowerCase()) : t.startsWith(p));
  const prefix = (spec.line ?? []).find((p) => starts(last, p));
  if (!prefix) return -1;
  let j = end;
  while (j > 0 && starts(lines[j - 1]!.trim(), prefix)) j--;
  return j;
}

/** Whether a comment's words begin with the first words of `doc` — the comment the analysis read it from. */
function startsWithDoc(rows: readonly string[], doc: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const want = words(doc).slice(0, 4);
  if (!want.length) return false;
  const have = words(rows.join(" ")).join(" ");
  return have.includes(want.join(" "));
}

/**
 * Whether the rows `from`..`to` (0-based, inclusive) hold nothing but blank rows and attributes — the
 * language's attribute shape, with an attribute's arguments spread over rows counting with it.
 */
export function onlyBlankOrAttributes(lines: readonly string[], from: number, to: number, spec: DocCommentSpec): boolean {
  let depth = 0;
  for (let r = from; r <= to; r++) {
    const row = lines[r] ?? "";
    if (depth > 0) depth += bracketDelta(row);
    else if (!row.trim()) continue;
    else if (spec.attribute?.test(row)) depth += bracketDelta(row);
    else return false;
  }
  return depth <= 0;
}
