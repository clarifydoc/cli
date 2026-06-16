/**
 * Angular component template extraction. Angular components are `.ts` files
 * with an `@Component({ template: '…inline html…' })` decorator (already parsed
 * as TypeScript). This finds the inline template and builds the same
 * framework-neutral component tree as Vue/React/Svelte, reusing the shared HTML
 * tokenizer with an Angular dialect (`*ngFor` loops, `(click)` events,
 * `[(ngModel)]` bindings, kebab-case component selectors).
 *
 * Limitation: only INLINE `template:` strings are supported. `templateUrl:`
 * (external .html) is not resolved — the analysis pipeline reads files
 * individually, so the sibling .html isn't available here.
 */
import type {
  InteractiveElementInfo,
  TemplateComponentNode,
} from "../../../types/analysis.js";
import {
  buildHtmlTemplateTree,
  resolveInteractiveElementKind,
  type TemplateDialect,
} from "../../../parsers/template-tree.js";

/** Angular template dialect for the shared HTML tokenizer. */
const ANGULAR_DIALECT: TemplateDialect = {
  isLoopAttr: (attrs) => /\*ngFor\b/.test(attrs),
  hasBinding: (attrs) =>
    /\([a-zA-Z][\w-]*\)\s*=/.test(attrs) || /\[\(ngModel\)\]/.test(attrs),
  extractProps: extractAngularProps,
};

/** Quick check: does this source look like an Angular component file? */
function looksAngular(sourceText: string): boolean {
  return /@Component\s*\(/.test(sourceText);
}

export function extractAngularComponentTree(
  sourceText: string,
): TemplateComponentNode[] {
  if (!looksAngular(sourceText)) return [];
  const tpl = extractInlineTemplate(sourceText);
  if (!tpl) return [];
  const roots: TemplateComponentNode[] = [];
  buildHtmlTemplateTree(tpl, sourceText, roots, ANGULAR_DIALECT);
  return roots;
}

/** Opening-tag matcher: captures (1) tag name, (2) the attribute blob. Mirrors
 *  `SVELTE_TAG_RE` — quoted attr values are skipped so `>` inside them doesn't
 *  end the tag early. */
const ANGULAR_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>'"])*?)\/?>/g;
/** `(event)="handler"` output binding: captures (1) event name, (2) handler. */
const ANGULAR_EVENT_RE = /\(([a-zA-Z][a-zA-Z0-9]*)\)\s*=\s*"([^"]*)"/g;

export function extractAngularInteractiveElements(
  sourceText: string,
): InteractiveElementInfo[] {
  if (!looksAngular(sourceText)) return [];
  const tpl = extractInlineTemplate(sourceText);
  if (!tpl) return [];

  const elements: InteractiveElementInfo[] = [];
  const tplOffset = sourceText.indexOf(tpl);
  ANGULAR_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANGULAR_TAG_RE.exec(tpl)) !== null) {
    const tag = match[1]!;
    const attrs = match[2] ?? "";
    const line = (sourceText.slice(0, tplOffset + match.index).match(/\n/g)?.length ?? 0) + 1;
    const element = resolveInteractiveElementKind(tag);

    // (event)="handler()" bindings.
    ANGULAR_EVENT_RE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = ANGULAR_EVENT_RE.exec(attrs)) !== null) {
      elements.push({ element, event: `(${e[1]})`, handler: cleanHandler(e[2] ?? null), line });
    }
    // [(ngModel)] two-way binding.
    if (/\[\(ngModel\)\]/.test(attrs)) {
      elements.push({ element, event: "[(ngModel)]", handler: null, line });
    }
  }
  return elements;
}

/**
 * Extract the inline `template:` string from an `@Component({...})` decorator.
 * Returns the template content (without the surrounding quotes), or null when
 * there's no inline template (e.g. `templateUrl:` only).
 */
function extractInlineTemplate(sourceText: string): string | null {
  // `template:` (not `templateUrl:`) followed by a backtick/single/double string.
  const m = sourceText.match(
    /(?:^|[\s,{])template\s*:\s*(?:`([\s\S]*?)`|'([^']*)'|"([^"]*)")/,
  );
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Extract prop/binding names from Angular tag attributes. */
function extractAngularProps(attrs: string): string[] {
  const props: string[] = [];
  // [prop]="x", prop="literal", [(ngModel)]="x" — but not (event)= or *ngX.
  const re = /(\[?\(?[a-zA-Z][\w-]*\)?\]?)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const raw = m[1]!;
    if (raw.startsWith("*")) continue; // structural directive (handled separately)
    if (/^\([a-zA-Z]/.test(raw) && !raw.startsWith("[(")) continue; // (event) handler
    const name = raw.replace(/[[\]()]/g, ""); // unwrap [], (), [()]
    if (!name || name === "class" || name === "style" || name.startsWith("ng")) continue;
    props.push(name);
  }
  return props;
}

/** Normalize a handler expression to a short name (`onClick($event)` → `onClick`). */
function cleanHandler(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const call = trimmed.match(/^([a-zA-Z_$][\w$.]*)/);
  return call ? call[1]!.split(".").pop()! : trimmed;
}
