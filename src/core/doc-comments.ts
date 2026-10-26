/**
 * The first sentence of the comment that documents a function or class —
 * `FunctionInfo.doc` / `ClassInfo.doc`. Read from the source as written: the
 * comment block just above the declaration (decorators and attributes may sit
 * between) or, where the language says so, the docstring that opens its body.
 * The language's shape comes from its plugin (`docComments`); core knows no
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

const LICENCE = /\b(?:copyright|licen[cs]ed?|spdx-license|all rights reserved)\b/i;
const DIRECTIVE = /^(?:frozen_string_literal|typed:|(?:en)?coding[:=]|@generated|auto-?generated|do not edit|go:\w|\+build|eslint|prettier|istanbul|tslint|@ts-|ts-|noqa|type:\s*ignore|pylint|rubocop|region\b|endregion\b|#region|nolint|nosec|todo\b|fixme\b|hack\b|xxx\b|-\*-|<reference\b)/i;
const TAG = /^(?:@\w|:(?:param|returns?|raises?|type|rtype)\b|\\(?:param|return)\b|<(?:param|typeparam|returns?|remarks|exception|example)\b|(?:Args|Arguments|Returns|Raises|Parameters|Example|Examples):$)/i;
/** C#'s summary wrapper and Doxygen's brief marker: around the text, not the end of it. */
const WRAPPER = /<\/?summary>|\\brief\s*/gi;
/** A line that reads as code, not prose: ends in `;`, `{` or `}`, or opens with a keyword and a symbol. */
const CODE_LINE = /(?:[;{}]\s*$)|^(?:import|export|const|let|var|return|if|for|while|def|fn|func|function|class|public|private)\b[^.]*[=({]/;

/** Attach `doc` to every function, class and method the comments of `source` document. */
export function attachDocComments(analysis: FileAnalysis, source: string, spec: DocCommentSpec | undefined): void {
  if (!spec || analysis.functions.length + analysis.classes.length === 0) return;
  if (!/\/\/|\/\*|#|--|"""|'''|\(\*|\{/.test(source)) return;
  const lines = source.split(/\r?\n/);
  const attach = (item: FunctionInfo | ClassInfo): void => {
    if (!item.line || item.line < 1 || item.line > lines.length) return;
    const doc = (spec.docstring ? docstringBelow(lines, item.line - 1) : null) ?? commentAbove(lines, item.line - 1, spec);
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
  while (i >= 0 && spec.attribute?.test(lines[i]!)) i--;
  // The declaration line may itself carry the decorators (`@Get() handler()`); the comment is still above.
  if (i < 0) return null;
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
        if (start > 0 && !/^\s*$/.test(t.slice(0, start))) return null;
        const text = body.join("\n");
        return clean(text.slice(0, text.lastIndexOf(close)).split("\n").map((l) => l.replace(/^\s*\*(?!\))\s?/, "")));
      }
      body.unshift(t);
    }
    // Not this block's opener (`/*` rather than `/**`): try the next shape.
  }
  if ((spec.block ?? []).some(([, close]) => last.endsWith(close))) return null;
  const prefix = (spec.line ?? []).find((p) => last.startsWith(p));
  if (!prefix) return null;
  const body: string[] = [];
  for (let j = i; j >= 0; j--) {
    const t = lines[j]!.trim();
    if (!t.startsWith(prefix)) break;
    body.unshift(t.slice(prefix.length));
  }
  return clean(body);
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
    if (TAG.test(t)) break;
    para.push(t);
  }
  let text = para.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 3 || LICENCE.test(text) || DIRECTIVE.test(text) || CODE_LINE.test(text)) return null;
  // XML doc tags (`<summary>`) wrap a C# comment's text; inline markup keeps its words.
  text = text.replace(/<\/?[a-z]+[^>]*>/gi, "").replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(text)) return null;
  const sentence = /^(.{12,}?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  if (sentence.length <= MAX_DOC_LENGTH) return sentence;
  const cut = sentence.slice(0, MAX_DOC_LENGTH - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_DOC_LENGTH / 2))}…`;
}
