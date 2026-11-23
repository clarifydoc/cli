import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { addSfFacts, isSfMarkup } from "./index.js";

/** An Aura or Visualforce file; any other `.cmp`, `.page` or `.component` (a component of another framework) is refused. */
export function sfmarkupSource(raw: string): PreprocessOutcome | { skip: string } {
  if (!isSfMarkup(raw)) return { skip: "not Aura or Visualforce markup" };
  return { sourceText: raw, language: "sfmarkup", postExtract: (analysis, source) => addSfFacts(analysis, source) };
}
