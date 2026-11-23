import type { FileAnalysis, Language } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { blankStringAwareComments } from "../shared/text-scan.js";

/**
 * A Lightning Web Component imports an Apex method as a function from a module path no file bears:
 * `import getClubs from '@salesforce/apex/ClubController.getClubs'` (a namespaced package adds `ns.` in front).
 * The class and the method are the last two segments; the type lives in the other language's files, which is
 * what `foreignImportTarget` tells core. Leaf code.
 */
export function apexImportTarget(source: string): { language: Language; type: string; member: string } | null {
  const m = /^@salesforce\/apex(?:Continuation)?\/(?:[\w]+\.)*([A-Za-z]\w*)\.([A-Za-z]\w*)$/.exec(source);
  return m ? { language: "apex", type: m[1]!, member: m[2]! } : null;
}

/** A wired adapter in a component's class: `@wire(getClubs, { season: '$season' }) clubs;`, `@wire(getClubs) loadClubs(result) {…}`. */
const WIRE = /@wire\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

/**
 * A wired Apex adapter runs when the component connects, for the component: the call it makes is the file's own
 * (`<setup>`), at the decorator's line, bound to the import the adapter's name is.
 */
function addWiredAdapterCalls(analysis: FileAnalysis, raw: string): void {
  const bound = new Map<string, string>();
  for (const imp of analysis.imports) {
    if (!apexImportTarget(imp.source)) continue;
    for (const spec of imp.specifiers) bound.set(spec, imp.source);
  }
  if (bound.size === 0) return;
  // A decorator in a comment is no wiring: blanked, the text keeps its lines and columns.
  for (const m of blankStringAwareComments(raw).matchAll(WIRE)) {
    const target = bound.get(m[1]!);
    if (!target) continue;
    const before = raw.slice(0, m.index);
    const line = before.split("\n").length;
    const column = m.index! - (before.lastIndexOf("\n") + 1) + m[0].indexOf(m[1]!);
    const call = { name: m[1]!, kind: "cross-file" as const, target, line, column, argCount: 1, confidence: "EXTRACTED" as const };
    const setup = analysis.functions.find((f) => f.name === "<setup>");
    if (setup) setup.calls.push(call);
    else analysis.functions.unshift({ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [call], line: 1, endLine: 1 });
  }
}

/** Wraps another preprocess's outcome (or none) so a component's wired Apex adapters become calls after extraction. */
export function withWiredAdapters(outcome: PreprocessOutcome | { skip: string } | null, rawSource: string, language: Language): PreprocessOutcome | { skip: string } | null {
  if (outcome && "skip" in outcome) return outcome;
  if (!rawSource.includes("@salesforce/apex") || !rawSource.includes("@wire")) return outcome;
  const base: PreprocessOutcome = outcome ?? { sourceText: rawSource, language };
  return {
    ...base,
    postExtract(analysis, raw) {
      base.postExtract?.(analysis, raw);
      addWiredAdapterCalls(analysis, raw);
    },
  };
}
