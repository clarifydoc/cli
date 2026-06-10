import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE as REGISTRY_EXTENSION_TO_LANGUAGE } from "../extractors/registry.js";

/**
 * Map file extensions to Language — aggregated from every plugin's meta
 * (`plugins/<lang>/meta.ts`, `extensions` field) by the plugin registry.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ...REGISTRY_EXTENSION_TO_LANGUAGE,
};

/** Get language for a file path based on its extension */
export function getLanguageForFile(filePath: string): Language | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = filePath.slice(lastDot);
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
