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
    sourceText: withAwaitedExpressions(rawSource, blankExceptScripts(rawSource)),
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

/**
 * A template's `{#await getAlbum({ id })}` runs its expression when the
 * component renders: kept in the parsed text at its own place, as a top-level
 * statement (`getAlbum({ id });`), so its calls are the component's `<setup>`
 * calls like those of its script. The block syntax around it is blanked.
 */
function withAwaitedExpressions(raw: string, blanked: string): string {
  if (!raw.includes("{#await")) return blanked;
  let out = blanked;
  for (const m of raw.matchAll(/\{#await\s+/g)) {
    const start = m.index!;
    // Only in the template: the blanked text is blank there.
    if (blanked[start] !== " " && blanked[start] !== "\n") continue;
    const exprStart = start + m[0].length;
    let depth = 0;
    let end = -1;
    for (let i = exprStart; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        for (i++; i < raw.length && raw[i] !== ch; i++) if (raw[i] === "\\") i++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      }
    }
    if (end < 0) continue;
    // `{#await promise then value}` / `{#await promise catch e}`: the promise only.
    const tail = /\s(?:then|catch)\b[^]*$/.exec(raw.slice(exprStart, end));
    const exprEnd = tail ? exprStart + tail.index : end;
    const expr = raw.slice(exprStart, exprEnd);
    if (!expr.trim() || expr.includes("\n\n")) continue;
    out = out.slice(0, exprStart) + expr + ";" + out.slice(exprEnd + 1);
  }
  return out;
}
