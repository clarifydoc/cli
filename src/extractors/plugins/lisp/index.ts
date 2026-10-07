import type { Language } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * The Lisp family's regex specs are empty on purpose: a Lisp form nests
 * however it likes, so nothing line-based is read. The whole file is read
 * by the s-expression reader in the plugin's `postExtract` (see meta.ts).
 */
export function lispSpec(language: Language, extensions: string[]): RegexLangSpec {
  return { language, extensions, lineCommentPrefixes: [";"], functionPatterns: [], classPatterns: [], importPatterns: [] };
}
