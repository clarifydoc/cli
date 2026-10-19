import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import {
  parseSvelteSfc,
  extractSvelteInteractiveElements,
} from "../../../parsers/svelte-sfc.js";
import { blankExceptScripts } from "../../../parsers/vue-sfc.js";

/**
 * Svelte SFC preprocessing: parse the `<script>` block as the file's source,
 * and merge markup data (component tree, interactive elements, component
 * usages) back into the analysis after extraction. Mirrors `vuePreprocess`.
 */
export function sveltePreprocess(
  rawSource: string,
  relativePath: string,
): PreprocessOutcome | { skip: string } | null {
  if (!relativePath.endsWith(".svelte")) return null;

  const sfc = parseSvelteSfc(rawSource);
  // A markup-only component (no <script>) is still a component: its template
  // renders children and carries buttons, and it is a file a parent imports.
  // Skipping it hid all of that — and made a dead one impossible to report.
  // The blanked source parses as an empty program.

  return {
    // Full source with non-script blanked out, so extracted line/column numbers
    // are absolute to the .svelte file (not relative to a sliced-out script).
    sourceText: blankExceptScripts(rawSource),
    language: sfc.scriptLang,
    embedded: true,
    postExtract(analysis) {
      // A .svelte file is a component with an implicit default export.
      if (!analysis.exports.some((e) => e.name === "default")) {
        analysis.exports.push({ name: "default", kind: "default", line: 1 });
      }

      // Nested component tree (consumed by the screen builder).
      analysis.templateTree = sfc.templateTree;

      if (sfc.template) {
        analysis.interactiveElements.push(
          ...extractSvelteInteractiveElements(sfc.template),
        );
      }

      for (const comp of sfc.templateComponents) {
        const importSource =
          analysis.imports.find((imp) => imp.specifiers.includes(comp.name))?.source ?? null;
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
