import type { FunctionInfo } from "../../../types/analysis.js";
import { codeOf } from "./di.js";

/**
 * Dart extension members:
 *
 * ```dart
 * extension ClubTypeBadge on ClubType { bool showBadge() => … }   // type.showBadge()
 * extension on Club { String crest() => … }                       // unnamed: club.crest()
 * extension Squad<P extends Player> on P { void rest() … }        // a bound: player.rest()
 * ```
 *
 * The plugin reads a named extension as a class and an unnamed one's members as free functions; this pass gives
 * each instance member of the block the extended type as its receiver (`isReceiver`, as Kotlin's
 * `fun Club.promote()` and Scala's `extension (c: Club)`), which is what lets the linker resolve `type.showBadge()`
 * on the type of `type`, and `this.x` inside the member on the extended type. A static member is called through
 * the extension's name and keeps none.
 *
 * An extension on one of its own type parameters (`on P`) applies to the parameter's bound, where Dart resolves it
 * statically; an unbounded one applies to every type and states nothing, so it keeps no receiver.
 */
interface ExtensionBlock {
  /** 1-based lines of the block's own body: from the line after its `{` … to the line of its `}`. */
  open: number;
  close: number;
  /** Brace depth at the start of each body line, relative to the block (1 = a member's own depth). */
  depthAt: Map<number, number>;
  type: string;
}

/** `extension [Name][<T …>] on Type {`, header text up to the body's brace. Never Dart 3 `extension type`. */
const HEADER_RE = /^\s*extension\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*)?(?:<([^{]*?)>\s*)?on\s+([^{]+?)\s*\{/;

/** Gives every instance member of an extension block in `lines` its receiver parameter. */
export function applyDartExtensionReceivers(lines: string[], fns: FunctionInfo[]): void {
  if (fns.length === 0 || !lines.some((l) => /^\s*extension\s/.test(l))) return;
  const blocks = extensionBlocks(lines);
  if (blocks.length === 0) return;
  for (const fn of fns) {
    if (fn.params.some((p) => p.isReceiver) || fn.isConstructor) continue;
    const block = blocks.find((b) => fn.line > b.open - 1 && fn.line <= b.close);
    if (!block || block.depthAt.get(fn.line) !== 1) continue;
    if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:external\s+)?static\b/.test(lines[fn.line - 1] ?? "")) continue;
    fn.params.unshift({ name: "this", type: block.type, defaultValue: null, isReceiver: true });
  }
}

function extensionBlocks(lines: string[]): ExtensionBlock[] {
  const out: ExtensionBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*extension\s/.test(lines[i]!)) continue;
    // The header may wrap (`extension ClubTypeBadge\n    on ClubType {`).
    let header = "";
    let braceLine = -1;
    for (let j = i; j < Math.min(lines.length, i + 6); j++) {
      const code = codeOf(lines[j]!);
      header += `${code} `;
      if (code.includes("{")) {
        braceLine = j;
        break;
      }
      if (code.includes(";")) break;
    }
    const m = braceLine >= 0 ? HEADER_RE.exec(header) : null;
    if (!m) continue;
    const type = receiverOf(m[2]!.trim(), m[1]);
    // The body: brace depth at each line's start, from the header's `{` to its match.
    const depthAt = new Map<number, number>();
    let depth = 0;
    let close = lines.length;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      if (started) depthAt.set(j + 1, depth);
      const code = codeOf(lines[j]!);
      for (const c of j === i ? code.slice(code.indexOf("extension")) : code) {
        if (c === "{") {
          depth++;
          started = true;
        } else if (c === "}" && started) depth--;
      }
      if (started && depth <= 0) {
        close = j + 1;
        break;
      }
    }
    if (type) out.push({ open: braceLine + 1, close, depthAt, type });
    i = close - 1;
  }
  return out;
}

/** The type an `on` clause extends: a type parameter is its bound, and an unbounded one states nothing. */
function receiverOf(on: string, typeParams: string | undefined): string | null {
  const bare = on.replace(/\?$/, "").trim();
  if (!typeParams || !/^[A-Za-z_$][\w$]*$/.test(bare)) return on;
  for (const param of splitTopLevel(typeParams)) {
    const p = /^\s*([A-Za-z_$][\w$]*)\s*(?:extends\s+(.+?))?\s*$/s.exec(param);
    if (p?.[1] !== bare) continue;
    return p[2] && !/^Object\??$|^dynamic$/.test(p[2].trim()) ? p[2].trim() : null;
  }
  return on;
}

/** `T extends Map<K, V>, K` split on its top-level commas. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}
