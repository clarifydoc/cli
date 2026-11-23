import type { FileAnalysis } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { apexDataSources } from "./soql.js";
import { apexDataText, apexStructureText, looksLikeApexClass } from "./source.js";

/** Runs once the file is analysed: SOQL, DML, triggers and callouts, scoped by the classes and functions found. */
function addData(analysis: FileAnalysis, raw: string): void {
  const rows = apexDataSources(apexDataText(raw), analysis.classes, [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)]);
  if (rows.length > 0) analysis.dataSources = [...analysis.dataSources, ...rows].sort((a, b) => a.line - b.line);
}

/** What the Apex plugin reads of an Apex source (see `source.ts`). */
export function apexSource(raw: string): PreprocessOutcome {
  return { sourceText: apexStructureText(raw), language: "apex", postExtract: addData, restoreTypedCalls: true };
}

/** An Apex class saved as `.cls`, whose extension VB6 owns: the outcome that hands it to the Apex plugin, else null. */
export function apexClassSource(raw: string): PreprocessOutcome | null {
  return looksLikeApexClass(raw) ? apexSource(raw) : null;
}

