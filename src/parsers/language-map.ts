import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE as REGISTRY_EXTENSION_TO_LANGUAGE, NAMED_FILE_LANGUAGE, SHEBANG_INTERPRETERS } from "../extractors/registry.js";

/**
 * Map file extensions to Language — aggregated from every plugin's meta
 * (`plugins/<lang>/meta.ts`, `extensions` field) by the plugin registry.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ...REGISTRY_EXTENSION_TO_LANGUAGE,
};

/** Get language for a file path based on its extension (case-insensitive:
 *  legacy Windows codebases ship `UNIT1.PAS` / `FORM1.DFM`). */
export function getLanguageForFile(filePath: string): Language | null {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1).toLowerCase();
  // Extension-less source files a plugin claims by name (Play `conf/routes`).
  const named = NAMED_FILE_LANGUAGE.get(base);
  if (named) return named;
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = filePath.slice(lastDot).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/**
 * The language of an extension-less script from its first line: the program a
 * `#!` line runs, looking through `env` and its flags/assignments
 * (`#!/usr/bin/env -S ruby -w` -> `ruby`). Null when the line is no shebang or
 * names an interpreter no plugin declares.
 */
export function getLanguageForShebang(firstLine: string): Language | null {
  if (!firstLine.startsWith("#!")) return null;
  const words = firstLine.slice(2).trim().split(/\s+/);
  const leaf = (w: string) => w.slice(w.lastIndexOf("/") + 1);
  let program = leaf(words[0] ?? "");
  if (program === "env") {
    // Options that take a value (`-u NAME`, `-C DIR`) are skipped with it.
    let i = 1;
    while (i < words.length && (words[i]!.startsWith("-") || words[i]!.includes("="))) {
      i += /^(?:-u|-C|--unset|--chdir)$/.test(words[i]!) ? 2 : 1;
    }
    program = leaf(words[i] ?? "");
  }
  if (!program) return null;
  return SHEBANG_INTERPRETERS.find((s) => s.pattern.test(program))?.language ?? null;
}
