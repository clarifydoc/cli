/**
 * Svelte single-file component parser. Extracts the `<script>` block (analyzed
 * as JS/TS) and builds a framework-neutral component tree from the markup,
 * reusing the shared HTML tokenizer. Svelte specifics: loops are `{#each}…
 * {/each}` blocks, events are `on:click`, bindings are `bind:value`, and
 * components are PascalCase tags.
 */
import type {
  InteractiveElementInfo,
  TemplateComponent,
  TemplateComponentNode,
} from "../types/analysis.js";
import {
  buildHtmlTemplateTree,
  extractScriptBlocks,
  flattenTemplateComponents,
  resolveInteractiveElementKind,
  type TemplateDialect,
} from "./template-tree.js";

export interface SvelteSfcBlocks {
  /** The `<script>` content (concatenated module + instance scripts). */
  script: string | null;
  /** The script language. */
  scriptLang: "typescript" | "javascript";
  /** The markup, with `<script>`/`<style>` blocked out (newlines preserved). */
  template: string | null;
  /** Component usages in the markup, de-duped & flat. */
  templateComponents: TemplateComponent[];
  /** Component usage as a nested tree mirroring the markup's element nesting. */
  templateTree: TemplateComponentNode[];
}

export function parseSvelteSfc(source: string): SvelteSfcBlocks {
  const scripts = extractScriptBlocks(source);
  const script = scripts.length ? scripts.map((s) => s.content).join("\n") : null;
  const scriptLang: "typescript" | "javascript" = scripts.some((s) =>
    /\blang\s*=\s*["'](ts|typescript)["']/i.test(s.attrs),
  )
    ? "typescript"
    : "javascript";

  // The markup is the whole file with <script>/<style> blocks blanked out,
  // newline count preserved so tree line numbers match the source. We pass the
  // blanked text as BOTH template and fullSource so `indexOf` is 0 and line
  // computation stays correct.
  const markup = blankNonMarkup(source);
  const hasMarkup = /<[A-Za-z]/.test(markup) || /\{#each\b/.test(markup);

  const templateTree: TemplateComponentNode[] = [];
  if (hasMarkup) {
    buildHtmlTemplateTree(markup, markup, templateTree, SVELTE_DIALECT);
  }
  const templateComponents: TemplateComponent[] = [];
  flattenTemplateComponents(templateTree, templateComponents, new Set());

  return {
    script,
    scriptLang,
    template: hasMarkup ? markup : null,
    templateComponents,
    templateTree,
  };
}

/**
 * Svelte dialect for the shared HTML tokenizer: block-level `{#each}` loops,
 * `on:`/`bind:` bindings, and attribute/shorthand prop extraction.
 */
const SVELTE_DIALECT: TemplateDialect = {
  isLoopAttr: () => false,
  blockLoopOpen: /\{#each\b[^}]*\}/,
  blockLoopClose: /\{\/each\}/,
  hasBinding: (attrs) => /\bon:[a-zA-Z]/.test(attrs) || /\bbind:[a-zA-Z]/.test(attrs),
  extractProps: extractSvelteProps,
};

/** Replace `<script>`/`<style>` blocks with blank lines (preserving newline
 *  count) so the remainder is pure markup with unchanged line numbers. */
function blankNonMarkup(source: string): string {
  const blank = (m: string): string => "\n".repeat((m.match(/\n/g)?.length ?? 0));
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, blank);
}

/** Extract prop/binding names from a Svelte tag's attributes. */
function extractSvelteProps(attrs: string): string[] {
  const props: string[] = [];
  // Full attribute keys: name, bind:value, on:click, class:active, etc.
  const re = /(?:^|\s)((?:bind:|on:|class:)?[a-zA-Z][a-zA-Z0-9:-]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const key = m[1]!;
    if (key.startsWith("on:")) continue; // events surface as event pills
    if (key.startsWith("on") && SVELTE5_EVENTS.has(key.slice(2))) continue; // Svelte 5 event attribute
    if (key === "class" || key === "style") continue;
    props.push(key);
  }
  // Shorthand `{prop}` and spread `{...rest}` — NOT `={value}` attribute
  // values (the leading `=` lookbehind excludes those).
  const short = /(?<!=)\{(\.\.\.)?([a-zA-Z][a-zA-Z0-9]*)\}/g;
  while ((m = short.exec(attrs)) !== null) {
    props.push(m[1] ? "...spread" : m[2]!);
  }
  return props;
}

/**
 * Extract interactive elements (event/`bind:` bindings) from Svelte markup, so
 * the screen builder can attach event pills to the matching tree nodes by line.
 */
const SVELTE_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^>'"{])*?)\/?>/g;
const SVELTE_EVENT_RE = /\bon:([a-zA-Z][a-zA-Z0-9]*)(?:=(?:"([^"]*)"|\{([^}]*)\}))?/g;
/**
 * Svelte 5 event attributes: `onclick={save}` / `onsubmit={(e) => …}` — plain
 * DOM event properties, no colon. Only known DOM events qualify, so a prop
 * named `once` or `onboarding` stays a prop.
 */
const SVELTE5_EVENTS: ReadonlySet<string> = new Set([
  "click", "dblclick", "input", "change", "submit", "reset", "keydown", "keyup", "keypress", "blur", "focus",
  "focusin", "focusout", "mousedown", "mouseup", "mouseenter", "mouseleave", "mouseover", "mouseout", "mousemove",
  "contextmenu", "touchstart", "touchend", "touchmove", "pointerdown", "pointerup", "pointermove", "drop",
  "dragstart", "dragend", "dragover", "scroll", "wheel", "load", "error", "toggle", "select", "paste", "copy", "cut",
]);
const SVELTE5_EVENT_RE = new RegExp(`\\bon(${[...SVELTE5_EVENTS].join("|")})=(?:"([^"]*)"|\\{([^}]*)\\})`, "g");
const SVELTE_BIND_RE = /\bbind:([a-zA-Z][a-zA-Z0-9]*)/g;

export function extractSvelteInteractiveElements(
  markup: string,
): InteractiveElementInfo[] {
  const elements: InteractiveElementInfo[] = [];
  SVELTE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SVELTE_TAG_RE.exec(markup)) !== null) {
    const tag = match[1]!;
    const attrs = match[2] ?? "";
    const line = (markup.slice(0, match.index).match(/\n/g)?.length ?? 0) + 1;
    const element = resolveInteractiveElementKind(tag);

    SVELTE_EVENT_RE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = SVELTE_EVENT_RE.exec(attrs)) !== null) {
      elements.push({
        element,
        event: `on:${e[1]}`,
        handler: cleanHandler(e[2] ?? e[3] ?? null),
        line,
      });
    }
    SVELTE5_EVENT_RE.lastIndex = 0;
    while ((e = SVELTE5_EVENT_RE.exec(attrs)) !== null) {
      elements.push({
        element,
        event: `on${e[1]}`,
        handler: cleanHandler(e[2] ?? e[3] ?? null),
        line,
      });
    }
    // bind:value etc. — a two-way binding worth surfacing on inputs/components.
    SVELTE_BIND_RE.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = SVELTE_BIND_RE.exec(attrs)) !== null) {
      elements.push({ element, event: `bind:${b[1]}`, handler: null, line });
    }
  }
  return elements;
}

/** Normalize a handler expression to a short name (`() => save()` → `save`). */
function cleanHandler(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const arrow = trimmed.match(/=>\s*([a-zA-Z_$][\w$]*)/);
  if (arrow) return arrow[1]!;
  const call = trimmed.match(/^([a-zA-Z_$][\w$]*)/);
  return call ? call[1]! : trimmed;
}
