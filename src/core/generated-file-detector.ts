import type { Language } from "../types/analysis.js";
import { generatedFilePatternsFor } from "../extractors/registry.js";

/**
 * Detects generated source from its file name.
 *
 * The existing generated-code detection is directory-based — barrel trees
 * discovered by `dead-code`, a `generated/` or `vendor/` path segment, plus
 * whatever a team writes into `.clarifydoc/config.json`. Every ecosystem also
 * has codegen that names FILES rather than folders, and all of it was
 * invisible: `Form1.Designer.cs` sits beside `Form1.cs`, `user.pb.go` beside
 * `user.go`. Its size, repetition and complexity counted against the team.
 *
 * A match does not stop the file being analyzed. Its screens, routes and
 * entities are real facts — a WinForms designer file is the only place a form's
 * layout exists — it is excluded from the quality signals.
 *
 * Two layers, mirroring the test-file detector: one cross-language convention
 * here, and the language-idiomatic patterns declared by each plugin.
 */

/** The one convention every ecosystem shares. Directory tokens are `dead-code`'s job. */
const GENERIC_GENERATED_PATTERNS: readonly RegExp[] = [/\.generated\.[^.\\/]+$/i];

const combinedCache = new Map<Language | "<none>", readonly RegExp[]>();

function patternsFor(language?: Language): readonly RegExp[] {
  const key = language ?? "<none>";
  let combined = combinedCache.get(key);
  if (!combined) {
    combined = language
      ? [...GENERIC_GENERATED_PATTERNS, ...generatedFilePatternsFor(language)]
      : GENERIC_GENERATED_PATTERNS;
    combinedCache.set(key, combined);
  }
  return combined;
}

/**
 * True when the file name follows a generated-code convention. Pass `language`
 * to apply that language's plugin-declared patterns too.
 */
export function isGeneratedFile(filePath: string, language?: Language): boolean {
  for (const re of patternsFor(language)) {
    if (re.test(filePath)) return true;
  }
  return false;
}
