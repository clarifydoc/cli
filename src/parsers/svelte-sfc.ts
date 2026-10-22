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
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, blank);
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

interface SvelteAttr {
  name: string;
  /** The `{…}` or quoted value as written, without its delimiters; null for a bare attribute. */
  value: string | null;
  /** `{onclick}` — the attribute named by its value. */
  shorthand?: boolean;
}

/**
 * Every tag of the markup with its attributes, read with braces balanced and
 * strings skipped — an attribute value may hold `{ … }` of its own
 * (`onclick={() => { save({ id }); }}`, `class={styles({ disabled })}`).
 */
function scanSvelteTags(markup: string): Array<{ tag: string; index: number; attrs: SvelteAttr[] }> {
  const out: Array<{ tag: string; index: number; attrs: SvelteAttr[] }> = [];
  const n = markup.length;
  /** The end (exclusive) of a `{…}` starting at `i`, strings and nested braces skipped. */
  const braceEnd = (i: number): number => {
    let depth = 0;
    for (let j = i; j < n; j++) {
      const c = markup[j]!;
      if (c === "'" || c === '"' || c === "`") {
        const q = c;
        for (j++; j < n && markup[j] !== q; j++) if (markup[j] === "\\") j++;
      } else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j + 1;
    }
    return n;
  };
  for (let i = 0; i < n; i++) {
    if (markup[i] === "{") {
      // A block or expression in text (`{#if …}`, `{value}`): never a tag.
      i = braceEnd(i) - 1;
      continue;
    }
    if (markup[i] !== "<" || !/[a-zA-Z]/.test(markup[i + 1] ?? "")) continue;
    const name = /^[a-zA-Z][\w.:-]*/.exec(markup.slice(i + 1, i + 200))![0];
    const attrs: SvelteAttr[] = [];
    let j = i + 1 + name.length;
    while (j < n && markup[j] !== ">") {
      const c = markup[j]!;
      if (/\s|\//.test(c)) { j++; continue; }
      if (c === "{") {
        const end = braceEnd(j);
        const inner = markup.slice(j + 1, end - 1).trim();
        if (/^[a-zA-Z_$][\w$]*$/.test(inner)) attrs.push({ name: inner, value: inner, shorthand: true });
        j = end;
        continue;
      }
      const key = /^[^\s=>/{]+/.exec(markup.slice(j, j + 200))?.[0];
      if (!key) { j++; continue; }
      j += key.length;
      let k = j;
      while (k < n && /\s/.test(markup[k]!)) k++;
      if (markup[k] !== "=") { attrs.push({ name: key, value: null }); continue; }
      k++;
      while (k < n && /\s/.test(markup[k]!)) k++;
      const v = markup[k];
      if (v === "{") {
        const end = braceEnd(k);
        attrs.push({ name: key, value: markup.slice(k + 1, end - 1) });
        j = end;
      } else if (v === '"' || v === "'") {
        let e = k + 1;
        while (e < n && markup[e] !== v) e = markup[e] === "{" ? braceEnd(e) : e + 1;
        const raw = markup.slice(k + 1, e);
        attrs.push({ name: key, value: /^\{[\s\S]*\}$/.test(raw.trim()) ? raw.trim().slice(1, -1) : raw });
        j = e + 1;
      } else {
        const bare = /^[^\s>]+/.exec(markup.slice(k))?.[0] ?? "";
        attrs.push({ name: key, value: bare });
        j = k + bare.length;
      }
    }
    out.push({ tag: name, index: i, attrs });
    i = j;
  }
  return out;
}

export function extractSvelteInteractiveElements(
  markup: string,
): InteractiveElementInfo[] {
  const elements: InteractiveElementInfo[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < markup.length; i++) if (markup[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const { tag, index, attrs } of scanSvelteTags(markup)) {
    const line = lineOf(index);
    const element = resolveInteractiveElementKind(tag);
    // A component (`<ArchiveAction>`, `<Modal.Root>`) takes callbacks as camelCase props (`onClick`, `onCheckedChange`).
    const component = /^[A-Z]/.test(tag) || tag.includes(".");
    for (const a of attrs) {
      let event: string | null = null;
      if (a.name.startsWith("on:")) event = a.name;
      else if (/^on[a-z]+$/.test(a.name) && SVELTE5_EVENTS.has(a.name.slice(2))) event = a.name;
      else if (component && /^on[A-Z]\w*$/.test(a.name)) event = a.name;
      if (event) {
        elements.push({ element, event, handler: cleanHandler(a.value), line, ...(component && element === "custom" ? { component: tag } : {}) });
      } else if (a.name.startsWith("bind:")) {
        // bind:value etc. — a two-way binding worth surfacing on inputs/components.
        elements.push({ element, event: a.name, handler: null, line });
      }
    }
  }
  return elements;
}

/** Normalize a handler expression to a short name (`() => save()` → `save`, `() => { void run({ id }); }` → `run`). */
function cleanHandler(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const arrow = trimmed.match(/=>\s*([a-zA-Z_$][\w$]*)/);
  if (arrow) return arrow[1]!;
  // A block body: the first function it calls.
  const block = /=>\s*\{([\s\S]*)\}\s*$/.exec(trimmed)?.[1];
  const called = block ? /(?:^|[^\w$.])(?!(?:if|for|while|switch|return|await|void|new|typeof|catch)\b)([a-zA-Z_$][\w$]*)\s*\(/.exec(block)?.[1] : undefined;
  if (called) return called;
  const call = trimmed.match(/^([a-zA-Z_$][\w$]*)/);
  return call ? call[1]! : trimmed;
}
