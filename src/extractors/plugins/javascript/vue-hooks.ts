import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { parseVueSfc } from "../../../parsers/vue-sfc.js";
import { extractVueInteractiveElements } from "./interactive-elements.js";

/**
 * Vue SFC preprocessing: parse the <script> block as the file's source, and
 * merge <template> data (interactive elements, component usages) back into
 * the analysis after extraction.
 */
export function vuePreprocess(
  rawSource: string,
  relativePath: string,
): PreprocessOutcome | { skip: string } | null {
  if (!relativePath.endsWith(".vue")) return null;

  const sfc = parseVueSfc(rawSource);
  if (!sfc.script) return { skip: "no <script> block" };

  return {
    sourceText: sfc.script,
    language: sfc.scriptLang,
    postExtract(analysis, raw) {
      if (sfc.template) {
        analysis.interactiveElements.push(
          ...extractVueInteractiveElements(sfc.template, raw),
        );
      }
      for (const comp of sfc.templateComponents) {
        const importSource =
          analysis.imports.find((imp) =>
            imp.specifiers.includes(comp.name),
          )?.source ?? null;
        if (!analysis.subComponents.some((sc) => sc.name === comp.name)) {
          analysis.subComponents.push({
            name: comp.name,
            importSource,
            props: comp.props,
            line: comp.line,
          });
        }
      }
    },
  };
}
