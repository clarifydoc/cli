import { readFile } from "fs/promises";
import { join } from "path";
import type { FileAnalysis, SymbolLink } from "../types/analysis.js";
import { manifestFor } from "../extractors/registry.js";
import { getLanguageForFile } from "../parsers/language-map.js";
import { analyzeWorkingFiles, loadFileAnalyses } from "./changed-symbols.js";

/** What a proposed edit would break before it is made: syntax it introduces, and calls with an argument count nothing accepts. */
export interface PatchCheck {
  /** Files whose proposed content parses with more errors than the file has now, and where (first ten lines). */
  syntax: Array<{ file: string; errors: number; before: number; lines: number[] }>;
  /** Calls in the proposed content whose argument count no definition of that name accepts (languages that record it: Java, Kotlin, C#). */
  arity: Array<{ file: string; line: number; call: string; passed: number; accepts: string }>;
}

type Node = { type: string; isMissing?: boolean; startPosition: { row: number }; children: Node[] };

/** Error and missing nodes in a parse, by their first line. */
function errorLines(root: Node): number[] {
  const out: number[] = [];
  const walk = (n: Node): void => {
    if (n.type === "ERROR" || n.isMissing) out.push(n.startPosition.row + 1);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

async function syntaxErrors(language: string, text: string, file: string): Promise<number[] | null> {
  if (manifestFor(language as never)?.parsing !== "tree-sitter") return null;
  try {
    const { parseSource } = await import("../parsers/parser-manager.js");
    const tree = await parseSource(text, language as never, file);
    return errorLines(tree.rootNode as unknown as Node);
  } catch {
    return null;
  }
}

/**
 * Check an edit not made yet. Syntax: each proposed file is parsed as the
 * analysis parses it, and one that comes out with more error nodes than the
 * file has now is reported with the lines. Arity: a call in the proposed
 * content that records its argument count (`CallInfo.argCount`) is checked
 * against every definition of that name the analysis links calls to — and the
 * proposed files' own — and reported only when none accepts that count.
 * Nothing is written.
 */
export async function checkPatch(
  projectRoot: string,
  analysisDir: string,
  symbolLinks: readonly SymbolLink[],
  contents: ReadonlyMap<string, string | null>,
): Promise<PatchCheck> {
  const out: PatchCheck = { syntax: [], arity: [] };
  for (const [file, text] of contents) {
    if (text === null) continue;
    const language = getLanguageForFile(file);
    if (!language) continue;
    const after = await syntaxErrors(language, text, file);
    if (!after?.length) continue;
    const current = await readFile(join(projectRoot, file), "utf8").catch(() => null);
    const before = current === null ? [] : (await syntaxErrors(language, current, file)) ?? [];
    if (after.length > before.length) out.syntax.push({ file, errors: after.length, before: before.length, lines: [...new Set(after)].slice(0, 10) });
  }

  // The proposed files as they would be, and the files defining what the analysis links calls to.
  const proposed = await analyzeWorkingFiles(projectRoot, [...contents.keys()], contents);
  const definers = new Map<string, Set<string>>();
  for (const l of symbolLinks) {
    if (l.navigational) continue;
    const leaf = l.targetSymbol.split(".").pop()!;
    (definers.get(leaf) ?? definers.set(leaf, new Set()).get(leaf)!).add(l.targetFile);
  }
  const wanted = new Set<string>();
  for (const a of proposed.values()) {
    for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) {
      for (const c of fn.calls ?? []) if (c.argCount !== undefined) for (const f of definers.get(c.name.split(".").pop()!) ?? []) wanted.add(f);
    }
  }
  const stored = await loadFileAnalyses(analysisDir, [...wanted].filter((f) => !contents.has(f)));
  const all = new Map<string, Pick<FileAnalysis, "functions" | "classes">>([...stored, ...proposed]);
  // Every definition by name: how many arguments it takes (required..total, open-ended when variadic).
  const accepts = new Map<string, Array<[number, number]>>();
  for (const a of all.values()) {
    const defs = [...a.functions.map((f) => [f.name, f] as const), ...a.classes.flatMap((c) => c.methods.map((m) => [m.name.split(".").pop()!, m] as const))];
    for (const [name, fn] of defs) {
      const params = (fn.params ?? []).filter((p) => p.name !== "self" && p.name !== "this");
      const variadic = params.some((p) => /^\.\.\.|^\*|\.\.\.$|^params\b/.test(p.name) || /\.\.\.|\[\]\s*\.\.\./.test(p.type ?? ""));
      const required = params.filter((p) => p.defaultValue === null && !/\?$/.test(p.name)).length;
      (accepts.get(name) ?? accepts.set(name, []).get(name)!).push([required, variadic ? Infinity : params.length]);
    }
  }
  for (const [file, a] of proposed) {
    for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) {
      for (const c of fn.calls ?? []) {
        if (c.argCount === undefined) continue;
        const leaf = c.name.split(".").pop()!;
        const ranges = accepts.get(leaf);
        // Only a name the project defines, every definition of it known: nothing to say about a library call.
        if (!ranges?.length || !definers.has(leaf) && ![...proposed.values()].some((p) => p.functions.some((f) => f.name === leaf) || p.classes.some((k) => k.methods.some((m) => m.name.split(".").pop() === leaf)))) continue;
        if (ranges.some(([lo, hi]) => c.argCount! >= lo && c.argCount! <= hi)) continue;
        const span = ranges.map(([lo, hi]) => (hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`));
        out.arity.push({ file, line: c.line ?? fn.line, call: c.name, passed: c.argCount, accepts: [...new Set(span)].join(" or ") });
      }
    }
  }
  return out;
}

/** The patch check as markdown, for the impact answer; empty when it found nothing. */
export function renderPatchCheck(p: PatchCheck): string {
  if (!p.syntax.length && !p.arity.length) return "";
  const lines = ["### Patch check", ""];
  for (const s of p.syntax) lines.push(`- **syntax** \`${s.file}\`: ${s.errors} parse error${s.errors === 1 ? "" : "s"}${s.before ? ` (the file has ${s.before} now)` : ""} — line${s.lines.length === 1 ? "" : "s"} ${s.lines.join(", ")}`);
  for (const a of p.arity) lines.push(`- **arguments** \`${a.file}:${a.line}\` \`${a.call}\` passes ${a.passed}; it takes ${a.accepts}`);
  return lines.join("\n");
}
