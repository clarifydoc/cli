import { projectCalleeIn } from "./markup-calls.js";

/**
 * The expressions a Vue or Svelte template evaluates when it renders — `{{ label(club) }}`,
 * `:msg="badge(m)"`, `v-for="p in sorted(players)"`, Svelte's `{fmtScore(n)}`, `{#if badge()}`,
 * `{#each rows() as r}`, `{@html crest(n)}`, `class={tone(n)}` — each kept in the parsed text
 * at its own place as a top-level statement (`;(label(club));`), so its calls are the
 * component's `<setup>` calls like those of its script, at their own lines. Handlers
 * (`@click`, `on:click`, `onfocus`) are the interactive elements' (`markupCalls`), a slot's
 * destructured parameters and a snippet's declaration are no expressions, and one that calls
 * nothing a project could define is left out.
 */
export function withMarkupExpressions(raw: string, blanked: string, kind: "vue" | "svelte"): string {
  const spans = kind === "vue" ? vueExpressions(raw) : svelteExpressions(raw);
  let out = blanked;
  // Back to front: a replacement changes the columns after it, never the lines.
  for (const { start, end, expr } of spans.sort((a, b) => b.start - a.start)) {
    if (!projectCalleeIn(expr)) continue;
    // Only in the template: the blanked text is blank there (a script keeps its own text).
    if (!/^\s*$/.test(out.slice(start, end))) continue;
    out = `${out.slice(0, start)};(${decodeEntities(expr)});${out.slice(end)}`;
  }
  return out;
}

interface Span { start: number; end: number; expr: string }

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const blankOf = (m: string) => m.replace(/[^\n\r]/g, " ");

/** The template part of a file: scripts, styles and comments blanked, offsets kept. */
function templateText(raw: string, vue: boolean): string {
  let t = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>|<!--[\s\S]*?-->/gi, blankOf);
  if (vue) {
    const m = /<template\b([^>]*)>([\s\S]*)<\/template>/i.exec(t);
    // A `lang="pug"` template is not HTML.
    if (!m || /\blang\s*=/.test(m[1]!)) return "";
    const from = m.index + m[0].indexOf(">") + 1;
    t = blankOf(t.slice(0, from)) + m[2] + blankOf(t.slice(from + m[2]!.length));
  }
  return t;
}

function vueExpressions(raw: string): Span[] {
  const t = templateText(raw, true);
  const spans: Span[] = [];
  for (const m of t.matchAll(/\{\{([\s\S]*?)\}\}/g)) spans.push({ start: m.index!, end: m.index! + m[0].length, expr: m[1]! });
  // Bound attributes: `:msg`, `v-bind:x`, `v-if`, `v-else-if`, `v-show`, `v-html`, `v-text`, `v-for` — never `@x`/`v-on`, `v-model`, a slot's parameters.
  for (const m of t.matchAll(/\s(:[^\s=]+|v-(?:bind|if|else-if|show|html|text|for|memo)[^\s=]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    let expr = m[3] ?? m[4] ?? "";
    // `p in players` / `(p, i) of players`: the collection is what is evaluated.
    if (m[1]!.startsWith("v-for")) expr = expr.replace(/^[\s\S]*?\s(?:in|of)\s+/, "");
    const quote = m.index! + m[0].length - m[2]!.length;
    spans.push({ start: quote, end: m.index! + m[0].length, expr });
  }
  return spans;
}

/** Attribute names whose braces are handlers, actions or bindings, never a value the markup computes. */
const NOT_VALUE = /\s(?:on[\w:.|-]*|(?:bind|use|transition|in|out|animate|let):[\w.|-]+)\s*=\s*["']?$/;

function svelteExpressions(raw: string): Span[] {
  const t = templateText(raw, false);
  const spans: Span[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") continue;
    const end = closingBrace(t, i);
    if (end < 0) continue;
    const open = i;
    i = end;
    if (NOT_VALUE.test(t.slice(Math.max(0, open - 60), open))) continue;
    const expr = svelteExpression(t.slice(open + 1, end));
    if (expr) spans.push({ start: open, end: end + 1, expr });
  }
  return spans;
}

/** The index of the `}` closing the `{` at `open`, strings and nested braces aware; -1 when none. */
function closingBrace(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const stop = t.indexOf(ch, i + 1);
      // A lone apostrophe in text between braces is no string: keep the scan inside the line.
      if (stop < 0 || t.slice(i, stop).includes("\n") && ch !== "`") continue;
      i = stop;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** What the markup tag `{…}` evaluates, or null for a block's close, a declaration, a debug tag, an await (its own hook). */
function svelteExpression(inner: string): string | null {
  const s = inner.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^#(?:if|key)\s+([\s\S]+)$/.exec(s))) return m[1]!;
  if ((m = /^#each\s+([\s\S]+?)\s+as\s[\s\S]*$/.exec(s))) return m[1]!;
  if ((m = /^:else\s+if\s+([\s\S]+)$/.exec(s))) return m[1]!;
  if (/^[#:/]/.test(s)) return null;
  if ((m = /^@(?:html|render)\s+([\s\S]+)$/.exec(s))) return m[1]!;
  if ((m = /^@const\s+[^=]+=\s*([\s\S]+)$/.exec(s))) return m[1]!;
  if (s.startsWith("@")) return null;
  return s.replace(/^\.\.\./, "");
}
