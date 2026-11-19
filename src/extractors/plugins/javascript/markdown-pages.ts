import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/**
 * A Markdown/MDX page under `pages/` is claimed path-scoped as TypeScript so
 * file-based routing can attach a frontend route — but its body is not JS.
 * Parse an empty module; the page's route comes from detectFileBasedRoutes /
 * vite-plugin-pages, not from the markup.
 */
export function markdownPagesPreprocess(
  _rawSource: string,
  relativePath: string,
): PreprocessOutcome | null {
  if (!/\.mdx?$/i.test(relativePath)) return null;
  return { sourceText: "export {}\n", language: "typescript" };
}
