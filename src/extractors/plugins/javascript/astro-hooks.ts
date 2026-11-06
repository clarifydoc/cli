import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { blankExceptAstroCode, parseAstro } from "../../../parsers/astro-sfc.js";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { withMarkupExpressions } from "./markup-expressions.js";
import { materializeElementRequests } from "../shared/element-requests.js";

/**
 * Astro component preprocessing: the frontmatter and the `<script>` blocks are the file's source (the rest
 * blanked, so lines stay the file's own); the markup's component tags, forms and links are merged back
 * into the analysis after extraction. Mirrors `sveltePreprocess`.
 */
export function astroPreprocess(rawSource: string, relativePath: string): PreprocessOutcome | { skip: string } | null {
  if (!relativePath.endsWith(".astro")) return null;
  const parsed = parseAstro(rawSource);
  return {
    sourceText: withMarkupExpressions(rawSource, blankExceptAstroCode(rawSource), "astro"),
    language: "typescript",
    embedded: true,
    postExtract(analysis) {
      // A `.astro` file is a component with an implicit default export.
      if (!analysis.exports.some((e) => e.name === "default")) analysis.exports.push({ name: "default", kind: "default", line: 1 });
      // `getStaticPaths` runs when the page is built, for the page: what it calls is the page's own.
      const paths = analysis.functions.find((f) => f.name === "getStaticPaths");
      if (paths) {
        const call = { name: "getStaticPaths", kind: "internal" as const, target: null, line: paths.line };
        const setup = analysis.functions.find((f) => f.name === "<setup>");
        if (setup) setup.calls.push(call);
        else analysis.functions.unshift({ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [call], line: 1, endLine: 1 });
      }
      analysis.templateTree = parsed.templateTree;
      analysis.interactiveElements.push(...extractHtmlInteractiveElements(parsed.markup.split("\n"), { requests: true }));
      materializeElementRequests(analysis);
      for (const comp of parsed.templateComponents) {
        const importSource = analysis.imports.find((imp) => imp.specifiers.includes(comp.name))?.source ?? null;
        if (!analysis.subComponents.some((sc) => sc.name === comp.name)) analysis.subComponents.push({ name: comp.name, importSource, props: comp.props, line: comp.line });
      }
    },
  };
}
