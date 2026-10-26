/**
 * Angular component template extraction. Angular components are `.ts` files
 * with an `@Component({ template: '…inline html…' })` decorator (already parsed
 * as TypeScript). This finds the inline template and builds the same
 * framework-neutral component tree as Vue/React/Svelte, reusing the shared HTML
 * tokenizer with an Angular dialect (`*ngFor` loops, `(click)` events,
 * `[(ngModel)]` bindings, kebab-case component selectors).
 *
 * Inline `template:` strings are extracted here per-file. External
 * `templateUrl:` files are resolved by a project-level pass
 * (`angular-external-templates.ts`) that reads the sibling .html and calls the
 * `*FromTemplate` variants below — the per-file pass can't, as the pipeline
 * reads files individually and the sibling .html isn't available here.
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
  // Inline template: line numbers are relative to the enclosing .ts source, so
  // the container for line offsets is sourceText (NOT the template slice).
  const roots: TemplateComponentNode[] = [];
  buildHtmlTemplateTree(tpl, sourceText, roots, ANGULAR_DIALECT);
  return roots;
}

/** Component tree from a standalone template (external `templateUrl` .html):
 *  line numbers are relative to the .html file, so the container IS the template. */
export function extractAngularComponentTreeFromTemplate(
  tpl: string,
): TemplateComponentNode[] {
  const roots: TemplateComponentNode[] = [];
  buildHtmlTemplateTree(tpl, tpl, roots, ANGULAR_DIALECT);
  return roots;
}

/**
 * The external template url of an `@Component({ templateUrl: './x.html' })`,
 * or null for inline-template / non-Angular files. Used by the project-level
 * external-template pass to locate the sibling .html.
 */
const TEMPLATE_URL_RE = /(?:^|[\s,{])templateUrl\s*:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/;
export function extractAngularTemplateUrl(sourceText: string): string | null {
  if (!looksAngular(sourceText)) return null;
  const m = sourceText.match(TEMPLATE_URL_RE);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
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
  // Inline template: line numbers are relative to the enclosing .ts source.
  return collectAngularInteractive(tpl, sourceText, sourceText.indexOf(tpl));
}

/** Interactive elements from a standalone template (external `templateUrl` .html). */
export function extractAngularInteractiveElementsFromTemplate(
  tpl: string,
): InteractiveElementInfo[] {
  // External template: line numbers are relative to the .html file itself.
  return collectAngularInteractive(tpl, tpl, 0);
}

/**
 * Scan template markup for interactive elements. `containerText`/`tplOffset`
 * anchor line numbers: for an inline template the container is the .ts source
 * and the offset locates the template within it; for an external template the
 * container IS the template and the offset is 0.
 */
function collectAngularInteractive(
  tpl: string,
  containerText: string,
  tplOffset: number,
): InteractiveElementInfo[] {
  const elements: InteractiveElementInfo[] = [];
  ANGULAR_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANGULAR_TAG_RE.exec(tpl)) !== null) {
    const tag = match[1]!;
    const attrs = match[2] ?? "";
    const line = (containerText.slice(0, tplOffset + match.index).match(/\n/g)?.length ?? 0) + 1;
    const element = resolveInteractiveElementKind(tag);

    // (event)="handler()" bindings.
    ANGULAR_EVENT_RE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = ANGULAR_EVENT_RE.exec(attrs)) !== null) {
      // A component's tag (`<app-cover-image>`) names the component whose output the event is.
      elements.push({ element, event: `(${e[1]})`, handler: cleanHandler(e[2] ?? null), line, ...(element === "custom" && tag.includes("-") ? { component: tag } : {}) });
    }
    // [(ngModel)] two-way binding.
    if (/\[\(ngModel\)\]/.test(attrs)) {
      elements.push({ element, event: "[(ngModel)]", handler: null, line });
    }
    // `routerLink="/clubs"` / `[routerLink]="['/clubs', club.id, 'view']"`: a link to a client route.
    const target = routerLinkTarget(attrs);
    if (target) elements.push({ element: "link", event: "click", handler: null, line, request: { method: "GET", target } });
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

/**
 * The client route a `routerLink` names, as an absolute path with each runtime
 * segment as `{}`; null when it is relative (`./edit`) or not literal.
 *   routerLink="/clubs"                          → /clubs
 *   [routerLink]="['/clubs', club.id, 'view']"   → /clubs/{}/view
 *   [routerLink]="'/clubs'"                      → /clubs
 */
export function routerLinkTarget(attrs: string): string | null {
  const plain = /(?:^|\s)routerLink\s*=\s*"([^"]*)"/.exec(attrs);
  if (plain) return plain[1]!.startsWith("/") ? plain[1]!.split(/[?#]/)[0]!.replace(/\{\{[^}]*\}\}/g, "{}") : null;
  const bound = /\[routerLink\]\s*=\s*"([^"]*)"/.exec(attrs)?.[1]?.trim();
  if (!bound) return null;
  const items = bound.startsWith("[") ? splitTopLevel(bound.slice(1, bound.lastIndexOf("]"))) : [bound];
  const segments: string[] = [];
  for (const [i, item] of items.entries()) {
    const lit = /^'([^']*)'$|^`([^`$]*)`$/.exec(item.trim());
    const text = lit ? (lit[1] ?? lit[2])! : null;
    if (i === 0 && (text === null || !text.startsWith("/"))) return null;
    segments.push(text === null ? "{}" : text.replace(/^\/+|\/+$/g, ""));
  }
  const path = "/" + segments.filter(Boolean).join("/");
  return path;
}

/** `a, f(b, c), 'd'` → its top-level comma-separated items. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * Normalize a handler expression to a short name (`onClick($event)` → `onClick`).
 * An output emitted straight from the markup keeps its output's name
 * (`read.emit(chapter)` → `read.emit`): the parent's handler is found through it.
 */
function cleanHandler(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const emit = /^(?:this\.)?([a-zA-Z_$][\w$]*)\.emit\s*\(/.exec(trimmed);
  if (emit) return `${emit[1]}.emit`;
  const call = trimmed.match(/^([a-zA-Z_$][\w$.]*)/);
  return call ? call[1]!.split(".").pop()! : trimmed;
}
