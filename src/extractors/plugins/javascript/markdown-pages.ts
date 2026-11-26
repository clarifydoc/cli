/**
 * A page is read only where the manifest's `pathScopedExtensions` admits it: `.md`/`.mdx` under `pages/` and, through
 * `packageJsonMatches`, where the nearest `package.json` names a framework that routes it (Astro, vite-plugin-pages,
 * `@next/mdx`, `@mdx-js/*`). Discovery applies the gate as `pathScopedAdmitted` and `getLanguageForFile` answers by
 * path alone, so a README or a docs repo's `pages/` stays unread.
 */

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
