import type { Language } from "../types/analysis.js";
import type { RegexLangSpec } from "../extractors/plugins/shared/regex-base.js";
import { goSpec } from "../extractors/plugins/go/index.js";
import { rustSpec } from "../extractors/plugins/rust/index.js";
import { rubySpec } from "../extractors/plugins/ruby/index.js";
import { phpSpec } from "../extractors/plugins/php/index.js";
import { swiftSpec } from "../extractors/plugins/swift/index.js";
import { luaSpec } from "../extractors/plugins/lua/index.js";
import { scalaSpec } from "../extractors/plugins/scala/index.js";
import { perlSpec } from "../extractors/plugins/perl/index.js";
import { vbSpec } from "../extractors/plugins/vb/index.js";
import { sqlSpec } from "../extractors/plugins/sql/index.js";
import { cSpec } from "../extractors/plugins/c/index.js";
import { cppSpec } from "../extractors/plugins/cpp/index.js";

/**
 * Extensions for languages handled by tree-sitter (no RegexLangSpec).
 * Plugin-backed extensions live with their specs; this map only covers the rest.
 */
const FALLBACK_EXTENSIONS: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".py": "python",
  ".pyw": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".pas": "pascal",
  ".pp": "pascal",
  ".lpr": "pascal",
  ".dpr": "pascal",
  ".dpk": "pascal",
  ".dfm": "dfm",
};

const REGEX_SPECS: RegexLangSpec[] = [
  goSpec, rustSpec, rubySpec, phpSpec, swiftSpec, luaSpec,
  scalaSpec, perlSpec, vbSpec, sqlSpec, cSpec, cppSpec,
];

function buildExtensionMap(): Record<string, Language> {
  const map: Record<string, Language> = { ...FALLBACK_EXTENSIONS };
  for (const spec of REGEX_SPECS) {
    for (const ext of spec.extensions) {
      map[ext] = spec.language;
    }
  }
  return map;
}

/** Map file extensions to Language — aggregated from plugin specs + fallback. */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = buildExtensionMap();

/** Get language for a file path based on its extension */
export function getLanguageForFile(filePath: string): Language | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = filePath.slice(lastDot);
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
