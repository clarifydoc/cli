import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { parseVueSfc, blankExceptScripts } from "../../../parsers/vue-sfc.js";
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
  // A markup-only component (no <script>) is still a component: its template
  // renders children and carries buttons, and it is a file a parent imports.
  // Skipping it hid all of that — and made a dead one impossible to report.
  // The blanked source parses as an empty program.

  return {
    // Full source with non-script blanked out, so extracted line/column numbers
    // are absolute to the .vue file (not relative to a sliced-out script).
    sourceText: blankExceptScripts(rawSource),
    language: sfc.scriptLang,
    postExtract(analysis, raw) {
      // A `<script setup>` SFC has no literal `export default`, but the file IS
      // a component with an implicit default export. Record it so dynamic
      // imports of the component (`import("./dlg.vue")`) and default imports
      // resolve to a real symbol in the symbol index.
      if (!analysis.exports.some((e) => e.name === "default")) {
        analysis.exports.push({ name: "default", kind: "default", line: 1 });
      }

      // Reproduce the template's real nesting (with looped nodes marked) for
      // the screen builder — consumed uniformly across frameworks via
      // `analysis.templateTree`.
      analysis.templateTree = sfc.templateTree;

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
