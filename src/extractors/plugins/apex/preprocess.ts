import type { FileAnalysis } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { apexDataSources } from "./soql.js";
import { apexDataText, apexStructureText, declaresApexType, hasVbMarkers } from "./source.js";

/** What the Apex plugin reads of an Apex source whose data text is `data` (see `source.ts`). */
function outcomeOf(data: string): PreprocessOutcome {
  // Runs once the file is analysed: SOQL, DML, triggers and callouts, scoped by the classes and functions found.
  const addData = (analysis: FileAnalysis): void => {
    const rows = apexDataSources(data, analysis.classes, [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)]);
    if (rows.length > 0) analysis.dataSources = [...analysis.dataSources, ...rows].sort((a, b) => a.line - b.line);
  };
  return { sourceText: apexStructureText(data), language: "apex", postExtract: addData, restoreTypedCalls: true };
}

/** An Apex source (`.trigger`). */
export function apexSource(raw: string): PreprocessOutcome {
  return outcomeOf(apexDataText(raw));
}

/** An Apex class saved as `.cls`, whose extension VB6 owns: the outcome that reads it, else null (a VB class). */
export function apexClassSource(raw: string): PreprocessOutcome | null {
  // The markers are tested on the raw text first: a file with none is no VB class, and one with them is VB's unless a
  // block comment may hold the marker line (`End Class of changes`), which the comment-free text decides.
  const marked = hasVbMarkers(raw);
  if (marked && !raw.includes("/*")) return null;
  const data = apexDataText(raw);
  return marked && hasVbMarkers(data) ? null : declaresApexType(data) ? outcomeOf(data) : null;
}
