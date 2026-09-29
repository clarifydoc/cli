import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE as REGISTRY_EXTENSION_TO_LANGUAGE, NAMED_FILE_LANGUAGE } from "../extractors/registry.js";

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
