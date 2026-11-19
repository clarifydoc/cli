import type { Language } from "../types/analysis.js";
import {
  EXTENSION_TO_LANGUAGE as REGISTRY_EXTENSION_TO_LANGUAGE,
  NAMED_FILE_LANGUAGE,
  PATH_SCOPED_EXTENSIONS,
  SHEBANG_INTERPRETERS,
} from "../extractors/registry.js";

/**
 * Map file extensions to Language — aggregated from every plugin's meta
 * (`plugins/<lang>/meta.ts`, `extensions` field) by the plugin registry.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ...REGISTRY_EXTENSION_TO_LANGUAGE,
};

/** Get language for a file path based on its extension (case-insensitive:
 *  legacy Windows codebases ship `UNIT1.PAS` / `FORM1.DFM`). Path-scoped
 *  claims (Markdown under `pages/`) win only when the path has that segment. */
export function getLanguageForFile(filePath: string): Language | null {
  const posix = filePath.replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).toLowerCase();
  // Extension-less source files a plugin claims by name (Play `conf/routes`).
  const named = NAMED_FILE_LANGUAGE.get(base);
  if (named) return named;
  const lastDot = posix.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = posix.slice(lastDot).toLowerCase();
  const global = EXTENSION_TO_LANGUAGE[ext];
  if (global) return global;
  // Path-scoped: `.md` under `pages/`, never a root README.
  for (const rule of PATH_SCOPED_EXTENSIONS) {
    if (ext !== rule.extension) continue;
    if (new RegExp(`(?:^|/)${rule.under.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`).test(posix)) {
      return rule.language;
    }
  }
  return null;
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
