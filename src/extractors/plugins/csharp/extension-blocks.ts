import type { FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { preprocessCsharpScript } from "./script.js";

/**
 * C# 14 extension blocks:
 *
 * ```csharp
 * public static class CarExtensions {
 *     extension(Car car) {
 *         public void Honk() { … }          // car.Honk()
 *         public static Car Build() => …;   // Car.Build()
 *     }
 * }
 * ```
 *
 * The grammar does not know them: it reads `extension(Car car)` as a
 * constructor and recovers from the block in ways that depend on what the
 * block holds. So the header is rewritten, before parsing, into a nested class
 * of the same length (`class __ext0      { … }` — every line and column after
 * it stays where it was), whose members then parse as methods; after
 * extraction they are moved onto the enclosing class, each with the block's
 * parameter as its receiver (`isReceiver`), as `static void Wash(this Car car)`
 * already has it.
 */

/** The C# preprocess: a script's directives (`script.ts`), then extension block headers. */
export function preprocessCsharp(rawSource: string, relativePath: string): PreprocessOutcome | null {
  const script = preprocessCsharpScript(rawSource, relativePath);
  const rewritten = rewriteExtensionBlocks(script?.sourceText ?? rawSource);
  if (!rewritten) return script;
  return {
    sourceText: rewritten.sourceText,
    language: "csharp",
    postExtract(analysis, raw) {
      script?.postExtract?.(analysis, raw);
      restoreExtensionBlocks(analysis, rewritten.blocks);
    },
  };
}

/** Where a block was: the synthetic class name, its line and the receiver it declares. */
interface ExtensionBlock {
  name: string;
  line: number;
  receiverType: string;
  receiverName: string | null;
}

const HEADER_RE = /\bextension\s*(?:<[^<>(){};]*(?:<[^<>(){};]*>[^<>(){};]*)*>\s*)?\(/g;

/**
 * Rewrite every extension block header of `source`; null when there is none.
 * A header is `extension` at member position (after `{`, `}`, `;` or an
 * attribute's `]`), its parameter list, an optional `where` clause, then `{`.
 */
export function rewriteExtensionBlocks(source: string): { sourceText: string; blocks: ExtensionBlock[] } | null {
  if (!source.includes("extension")) return null;
  const blocks: ExtensionBlock[] = [];
  let out = source;
  HEADER_RE.lastIndex = 0;
  for (let m = HEADER_RE.exec(source); m; m = HEADER_RE.exec(source)) {
    if (!atMemberPosition(source, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchingParen(source, open);
    if (close < 0) continue;
    // `where T : IFoo` constraints, then the block's brace.
    const brace = /^\s*(?:where\b[^{};]*)?\{/.exec(source.slice(close + 1));
    if (!brace) continue;
    const end = close + 1 + brace[0].length - 1; // index of `{`
    const receiver = parseReceiver(source.slice(open + 1, close));
    if (!receiver) continue;
    const name = `__ext${blocks.length}`;
    const replacement = `class ${name}`;
    const header = source.slice(m.index, end);
    // The name takes the header's first line; the rest is blanked, its line breaks kept (a `where` on its own line).
    if (replacement.length > header.length || /[\r\n]/.test(header.slice(0, replacement.length))) continue;
    const padded = replacement + header.slice(replacement.length).replace(/[^\r\n]/g, " ");
    out = out.slice(0, m.index) + padded + out.slice(end);
    blocks.push({ name, line: source.slice(0, m.index).split("\n").length, ...receiver });
  }
  return blocks.length > 0 ? { sourceText: out, blocks } : null;
}

/**
 * Move each rewritten block's members onto the class enclosing it, with the
 * block's parameter as their receiver. A static member (`Car.Build()`) is
 * called on the type, which the receiver names all the same. The block's
 * properties are left out: nothing calls them.
 */
export function restoreExtensionBlocks(analysis: FileAnalysis, blocks: readonly ExtensionBlock[]): void {
  for (const block of blocks) {
    const index = analysis.classes.findIndex((c) => c.name === block.name);
    if (index < 0) continue;
    const synthetic = analysis.classes[index]!;
    analysis.classes.splice(index, 1);
    let owner: FileAnalysis["classes"][number] | undefined;
    for (const c of analysis.classes) {
      if (c.line > block.line || c.endLine < synthetic.endLine) continue;
      if (!owner || c.line >= owner.line) owner = c;
    }
    if (!owner) continue;
    for (const m of synthetic.methods) {
      const receiver = { name: block.receiverName ?? "this", type: block.receiverType, defaultValue: null, isReceiver: true };
      const method: FunctionInfo = { ...m, params: [receiver, ...m.params] };
      owner.methods.push(method);
    }
  }
}

/** Whether the token at `index` starts a member: the code before it ends in `{`, `}`, `;` or `]`. */
function atMemberPosition(source: string, index: number): boolean {
  let before = source.slice(Math.max(0, index - 2000), index);
  for (;;) {
    before = before.replace(/\s+$/, "");
    const lastLine = before.slice(before.lastIndexOf("\n") + 1);
    const comment = lastLine.indexOf("//");
    if (comment >= 0 && !lastLine.slice(0, comment).includes('"')) {
      before = before.slice(0, before.length - lastLine.length + comment);
      continue;
    }
    if (before.endsWith("*/")) {
      const start = before.lastIndexOf("/*");
      if (start < 0) return false;
      before = before.slice(0, start);
      continue;
    }
    break;
  }
  return before.length === 0 || /[{};\]]$/.test(before);
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length && i < open + 1000; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
    else if (ch === "{" || ch === ";") return -1;
  }
  return -1;
}

/** `Car car` / `Car` / `List<T> list` / `ref Car car` → the receiver's type and name. */
function parseReceiver(text: string): { receiverType: string; receiverName: string | null } | null {
  const t = text.replace(/\[[^\]]*\]/g, " ").replace(/\b(?:ref|in|scoped|readonly)\s+/g, "").trim();
  if (!t || t.includes(",")) {
    // A generic type's arguments may hold commas; only a top-level comma is a second parameter.
    if (!t || depthZeroComma(t)) return null;
  }
  const m = /^(.*?[\w>\]?])\s+(@?[A-Za-z_]\w*)$/s.exec(t);
  if (m) return { receiverType: m[1]!.trim(), receiverName: m[2]!.replace(/^@/, "") };
  return /^[\w.<>,\s?[\]]+$/.test(t) ? { receiverType: t, receiverName: null } : null;
}

function depthZeroComma(t: string): boolean {
  let depth = 0;
  for (const ch of t) {
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}
