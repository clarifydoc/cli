import type { CustomElementDef } from "../../../types/analysis.js";

/**
 * Detect Web Component (custom element) registrations in JS/TS source:
 *
 *   customElements.define("user-card", UserCard)          → { tag, className }
 *   window.customElements.define('user-card', UserCard)
 *   @customElement("user-card") class UserCard extends…    (Lit / FASTElement)
 *
 * Custom elements are consumed in markup by their kebab tag (`<user-card>`),
 * never by an imported symbol, so this registration is the ONLY bridge from a
 * template usage back to the implementing class. A source-text scan is used
 * (not the AST): `customElements.define` and `@customElement` are unambiguous
 * string shapes, and this runs on every JS/TS file so it must stay cheap — the
 * two `includes` gates below skip the scan entirely for the vast majority of
 * files that register nothing.
 */

const DEFINE_RE = /customElements\s*\.\s*define\s*\(\s*['"]([a-z][a-z0-9]*-[\w-]*)['"]\s*,\s*([A-Za-z_$][\w$]*)/g;
const LIT_RE = /@customElement\s*\(\s*['"]([a-z][a-z0-9]*-[\w-]*)['"]\s*\)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function extractCustomElements(sourceText: string): CustomElementDef[] {
  const hasDefine = sourceText.includes("customElements");
  const hasLit = sourceText.includes("@customElement");
  if (!hasDefine && !hasLit) return [];

  const out: CustomElementDef[] = [];
  const seen = new Set<string>();
  const push = (tag: string, className: string, index: number) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    out.push({ tag, className, line: lineAt(sourceText, index) });
  };

  if (hasDefine) {
    DEFINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEFINE_RE.exec(sourceText)) !== null) push(m[1]!, m[2]!, m.index);
  }
  if (hasLit) {
    LIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LIT_RE.exec(sourceText)) !== null) push(m[1]!, m[2]!, m.index);
  }
  return out;
}
