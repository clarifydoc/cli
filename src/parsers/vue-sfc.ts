/**
 * Vue Single File Component (SFC) parser.
 * Extracts <script>, <template>, and <style> blocks from .vue files
 * without needing a tree-sitter-vue grammar.
 */

import type { TemplateComponent, TemplateComponentNode } from "../types/analysis.js";
import {
  buildHtmlTemplateTree,
  extractScriptBlocks,
  flattenTemplateComponents,
  type TemplateDialect,
} from "./template-tree.js";

// Re-export so existing importers of these types from this module keep working.
export type { TemplateComponent, TemplateComponentNode };

export interface VueSfcBlocks {
  /** The script content (from <script> or <script setup>) */
  script: string | null;
  /** Whether the script uses <script setup> */
  isSetup: boolean;
  /** The script language (ts, js, or null) */
  scriptLang: "typescript" | "javascript";
  /** The template content */
  template: string | null;
  /** Component names used in the template (uppercase tags), de-duped & flat. */
  templateComponents: TemplateComponent[];
  /** Component usage as a nested tree mirroring the template's element nesting,
   *  with `vFor` set when the component (or an enclosing element) carries
   *  `v-for`. Every occurrence is present — not de-duped — so the structure is
   *  faithful. */
  templateTree: TemplateComponentNode[];
}

/**
 * Return `source` with everything except `<script>` block *content* replaced by
 * spaces, preserving all newlines. The result parses as the same script but at
 * the SFC's original line/column positions — so functions, calls and symbol
 * links get absolute file coordinates instead of ones relative to a sliced-out
 * script (which is what made `.vue`/`.svelte` line numbers wrong downstream).
 * Handles multiple blocks (a plain `<script>` plus a `<script setup>`).
 */
export function blankExceptScripts(source: string): string {
  const out = source.replace(/[^\n\r]/g, " ").split("");
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    const content = m[1] ?? "";
    const start = m.index + m[0].indexOf(">") + 1; // first '>' closes the opening tag
    for (let i = 0; i < content.length; i++) out[start + i] = source[start + i];
  }
  return out.join("");
}

/**
 * Parse a .vue SFC file and extract its blocks.
 */
export function parseVueSfc(source: string): VueSfcBlocks {
  // A SFC may carry BOTH a plain `<script>` (e.g. an `export default`/enum) and
  // a `<script setup>` block — concatenate them so imports and logic from every
  // block are analyzed (the setup block usually holds the imports).
  const scripts = extractScriptBlocks(source);
  const script = scripts.length ? scripts.map((s) => s.content).join("\n") : null;
  const isSetup = scripts.some((s) => /\bsetup\b/.test(s.attrs));
  const scriptLang: "typescript" | "javascript" = scripts.some((s) =>
    /\blang\s*=\s*["'](ts|typescript)["']/i.test(s.attrs),
  )
    ? "typescript"
    : "javascript";

  const template = extractTemplateBlock(source);

  // Extract component usage from the template as a nested tree, then derive the
  // flat, de-duped list (used elsewhere for component-usage edges) from it.
  const templateTree: TemplateComponentNode[] = [];
  if (template) {
    buildHtmlTemplateTree(template, source, templateTree, VUE_DIALECT);
  }
  const templateComponents: TemplateComponent[] = [];
  flattenTemplateComponents(templateTree, templateComponents, new Set());

  return {
    script: script,
    isSetup,
    scriptLang,
    template,
    templateComponents,
    templateTree,
  };
}

/**
 * Extract the root `<template>` content. A SFC has one root template, but it can
 * contain nested slot `<template #slot>` blocks — match greedily from the first
 * `<template>` to the LAST `</template>` so the whole template is captured (a
 * non-greedy match would stop at the first nested slot's close).
 */
function extractTemplateBlock(source: string): string | null {
  const match = source.match(/<template\b[^>]*>([\s\S]*)<\/template>/i);
  return match ? match[1] : null;
}

/**
 * Vue template dialect for the shared HTML tokenizer: `v-for` loops, `@event` /
 * `v-on:` / `v-model` bindings, and `:`/`v-bind:` prop extraction.
 */
const VUE_DIALECT: TemplateDialect = {
  isLoopAttr: (attrs) => /\bv-for\b/.test(attrs),
  hasBinding: (attrs) =>
    /@[a-zA-Z]/.test(attrs) || /\bv-on:/.test(attrs) || /\bv-model\b/.test(attrs),
  extractProps: extractVueProps,
};

/** Extract prop names from Vue template attributes */
function extractVueProps(attrs: string): string[] {
  const props: string[] = [];
  // Match: prop-name, :prop-name, v-bind:prop-name, @event-name, v-model
  const propRegex = /(?::|v-bind:)?([a-zA-Z][a-zA-Z0-9-]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = propRegex.exec(attrs)) !== null) {
    const name = m[1];
    if (!name.startsWith("v-") && name !== "class" && name !== "style") {
      props.push(name);
    }
  }
  // v-model
  if (attrs.includes("v-model")) props.push("v-model");
  return props;
}
