/**
 * Astro component parser. A `.astro` file is a frontmatter script between two `---` fences (TypeScript,
 * run on the server), markup (HTML with components, `{expressions}` and `<slot />`) and optional
 * `<script>` blocks for the browser. The frontmatter and the scripts are analyzed as TypeScript; the
 * markup becomes the component tree through the shared HTML tokenizer.
 */
import type { TemplateComponent, TemplateComponentNode } from "../types/analysis.js";
import { buildHtmlTemplateTree, flattenTemplateComponents, type TemplateDialect } from "./template-tree.js";

export interface AstroBlocks {
  /** The frontmatter's inner span, as 0-based character offsets into the source; null with no fences. */
  frontmatter: { start: number; end: number } | null;
  /** The markup, with the frontmatter, `<script>` and `<style>` blocks blanked (newlines kept). */
  markup: string;
  templateComponents: TemplateComponent[];
  templateTree: TemplateComponentNode[];
}

const blank = (m: string): string => m.replace(/[^\n]/g, " ");

/** The frontmatter fences: the file's first line is `---`, the next line made only of `---` closes it. */
export function astroFrontmatter(source: string): { start: number; end: number; close: number } | null {
  const open = /^(?:﻿)?[ \t]*---[ \t]*\r?\n/.exec(source);
  if (!open) return null;
  const rest = source.slice(open[0].length);
  const close = /(^|\n)[ \t]*---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return null;
  const start = open[0].length;
  const end = start + close.index + close[1]!.length;
  return { start, end, close: end + close[0].length - close[1]!.length };
}

/** The source with everything but the frontmatter code and the `<script>` contents blanked, line for line. */
export function blankExceptAstroCode(source: string): string {
  const out = source.replace(/[^\n\r]/g, " ").split("");
  const fm = astroFrontmatter(source);
  if (fm) for (let i = fm.start; i < fm.end; i++) out[i] = source[i]!;
  const marked = fm ? source.slice(0, fm.close).replace(/[^\n]/g, " ") + source.slice(fm.close) : source;
  for (const m of marked.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    const start = m.index! + m[0].indexOf(">") + 1;
    for (let i = 0; i < m[1]!.length; i++) out[start + i] = source[start + i]!;
  }
  return out.join("");
}

const ASTRO_DIALECT: TemplateDialect = {
  isLoopAttr: () => false,
  // A hydration directive (`client:load`) is what makes a component worth showing on its own.
  hasBinding: (attrs) => /\bclient:[a-z]+/.test(attrs),
  extractProps: (attrs) => [...attrs.matchAll(/(?:^|\s)((?:client:|set:|class:)?[a-zA-Z][\w:-]*)\s*=/g)].map((m) => m[1]!).filter((k) => k !== "class" && k !== "style"),
};

export function parseAstro(source: string): AstroBlocks {
  const fm = astroFrontmatter(source);
  const withoutFrontmatter = fm ? source.slice(0, fm.close).replace(/[^\n]/g, " ") + source.slice(fm.close) : source;
  const markup = withoutFrontmatter
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, blank);
  const templateTree: TemplateComponentNode[] = [];
  if (/<[A-Za-z]/.test(markup)) buildHtmlTemplateTree(markup, markup, templateTree, ASTRO_DIALECT);
  const templateComponents: TemplateComponent[] = [];
  flattenTemplateComponents(templateTree, templateComponents, new Set());
  return { frontmatter: fm ? { start: fm.start, end: fm.end } : null, markup, templateComponents, templateTree };
}

export interface AstroAssetRef {
  /** The specifier as the resolver reads it: relative as written, a `/`-rooted one under `public/`. */
  source: string;
  line: number;
}

/**
 * The files a page loads through `<script src>` and `<link href>` (stylesheet, modulepreload): a relative
 * path, or a `/`-rooted one that Astro serves from `public/`. Absolute URLs, other `<link>` kinds, comments
 * and the frontmatter are left out.
 */
export function astroAssetRefs(source: string): AstroAssetRef[] {
  const fm = astroFrontmatter(source);
  const text = (fm ? source.slice(0, fm.close).replace(/[^\n]/g, " ") + source.slice(fm.close) : source).replace(/<!--[\s\S]*?-->/g, blank);
  const refs: AstroAssetRef[] = [];
  const attr = (attrs: string, name: string): string | null => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
    return m ? (m[1] ?? m[2] ?? "").trim() : null;
  };
  for (const m of text.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = m[2]!;
    const isScript = m[1]!.toLowerCase() === "script";
    if (!isScript && !/^(?:stylesheet|modulepreload)$/i.test(attr(attrs, "rel") ?? "")) continue;
    const ref = attr(attrs, isScript ? "src" : "href");
    if (!ref || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(ref) || /[{}]/.test(ref)) continue;
    const path = ref.replace(/[?#].*$/, "");
    if (!path) continue;
    const line = text.slice(0, m.index!).split("\n").length;
    refs.push({ source: path.startsWith("/") ? `public${path}` : path, line });
  }
  return refs;
}
