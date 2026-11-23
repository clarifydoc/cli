import type {
  CallInfo,
  FileAnalysis,
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
  SubComponentInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Aura components (`.cmp`) and Visualforce pages and components (`.page`, `.component`): XML-like markup whose
 * behaviour sits elsewhere. An Aura component names its Apex controller in `<aura:component controller="ClubController">`
 * and its script handlers as `{!c.handleSave}`; a Visualforce page names `controller=` and `extensions=` and binds
 * `action="{!save}"` and `value="{!clubs}"` to their members. This file reads what the markup states; the resolver
 * beside it (`resolver.ts`) joins it to the script and Apex files.
 */

export interface SfTag {
  /** Name as written (`lightning:button`, `apex:commandButton`). */
  name: string;
  prefix: string;
  local: string;
  attrs: Record<string, string>;
  line: number;
  column: number;
  children: SfTag[];
}

const TAG_TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** XML comments blanked, newlines kept so lines and columns hold. */
function stripComments(text: string): string {
  // Script and style bodies are no markup (`i<n` is no tag): blanked with the comments.
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(?=<\/\2>)/gi, (_, open: string, __: string, body: string) => open + body.replace(/[^\n]/g, " "));
}

/** HTML elements with no closing tag: never an ancestor. */
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

/** The markup's tags as a tree, in document order, with every tag also in `flat`. */
export function parseSfMarkup(source: string): { root: SfTag | null; flat: SfTag[] } {
  const text = stripComments(source);
  const flat: SfTag[] = [];
  const stack: SfTag[] = [];
  let root: SfTag | null = null;
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const m of text.matchAll(TAG_TOKEN)) {
    for (let i = text.indexOf("\n", scanned); i !== -1 && i < m.index!; i = text.indexOf("\n", i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = m.index!;
    const name = m[2]!;
    if (m[1] === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (name.startsWith("?") || name.startsWith("!")) continue;
    const colon = name.indexOf(":");
    const tag: SfTag = {
      name,
      prefix: colon === -1 ? "" : name.slice(0, colon),
      local: colon === -1 ? name : name.slice(colon + 1),
      attrs: {},
      line,
      column: m.index! - lineStart,
      children: [],
    };
    for (const a of m[3]!.matchAll(ATTR)) tag.attrs[a[1]!] = a[2] ?? a[3] ?? "";
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(tag);
    else if (!root) root = tag;
    flat.push(tag);
    if (m[4] !== "/" && !VOID.has(name.toLowerCase())) stack.push(tag);
  }
  return { root, flat };
}

/** The root tags that make a file Aura or Visualforce markup. */
const ROOT_TAG = /^(?:aura:(?:component|application|event|interface)|apex:(?:page|component))$/;

export function isSfMarkup(source: string): boolean {
  return /<(?:aura:(?:component|application|event|interface)|apex:(?:page|component))[\s>]/.test(stripComments(source));
}

export type SfKind = "aura" | "visualforce";

export function kindOf(root: SfTag | null): SfKind | null {
  if (!root || !ROOT_TAG.test(root.name)) return null;
  return root.prefix === "aura" ? "aura" : "visualforce";
}

/** A class name as an attribute states it, without a namespace prefix: `ns.ClubController` → `ClubController`. */
function classLeaf(text: string | undefined): string | null {
  const leaf = text?.trim().split(".").pop();
  return leaf && /^[A-Za-z_]\w*$/.test(leaf) ? leaf : null;
}

/** The Apex controller a component or page names, and the extensions of a Visualforce page, in order. */
export function bindingsOf(root: SfTag): { controller: string | null; extensions: string[] } {
  const controller = classLeaf(root.attrs["controller"]);
  const extensions = (root.attrs["extensions"] ?? "").split(",").map(classLeaf).filter((x): x is string => x !== null);
  return { controller, extensions };
}

// ─── Handlers ─────────────────────────────────────────────────────────────

const AURA_HANDLER = /^\{!\s*c\.([A-Za-z_]\w*)\s*\}$/;
const VF_ACTION = /^\{!\s*([A-Za-z_]\w*)\s*\}$/;

function elementOf(tag: SfTag): InteractiveElementInfo["element"] {
  if (/button|menuitem/i.test(tag.local)) return "button";
  if (/link|anchor/i.test(tag.local)) return "link";
  if (/select|combobox|picklist/i.test(tag.local)) return "select";
  if (/input|textarea|slider|checkbox|radio/i.test(tag.local)) return "input";
  return "custom";
}

/** `onclick` → `click`, `onchange` → `change`; `action`, `press` and the rest as written. */
function eventOf(attr: string, tag: SfTag): string {
  if (tag.name === "aura:handler") return tag.attrs["name"] ?? "event";
  return attr.replace(/^on/, "");
}

export function extractSfInteractiveElements(source: string): InteractiveElementInfo[] {
  const { root, flat } = parseSfMarkup(source);
  const kind = kindOf(root);
  if (!kind) return [];
  const out: InteractiveElementInfo[] = [];
  for (const tag of flat) {
    for (const [attr, value] of Object.entries(tag.attrs)) {
      if (kind === "aura") {
        const m = AURA_HANDLER.exec(value.trim());
        // `{!c.x}` is the controller's function wherever it is bound; a `v.` or `!` expression is a value.
        if (m) out.push({ element: elementOf(tag), event: eventOf(attr, tag), handler: m[1]!, line: tag.line, column: tag.column, component: tag.name });
      } else if (attr === "action") {
        const m = VF_ACTION.exec(value.trim());
        if (m) out.push({ element: elementOf(tag), event: tag === root ? "load" : "click", handler: m[1]!, line: tag.line, column: tag.column, component: tag.name });
      }
    }
  }
  return out;
}

// ─── Screens ───────────────────────────────────────────────────────────────

const CATEGORY: Array<[RegExp, ScreenComponentCategory]> = [
  [/button|commandlink|actionfunction|menuitem/i, "action"],
  [/input|textarea|select|checkbox|radio|slider|inputfield/i, "input"],
  [/text|output|image|icon|spinner|messages|message$|badge|formattedtext/i, "display"],
  [/iteration|table|datatable|list|repeat|column/i, "data"],
  [/tab|nav|breadcrumb|menu|path/i, "navigation"],
  [/form|block|section|panel|card|layout|component|page|app/i, "container"],
];

function categoryOf(tag: SfTag): ScreenComponentCategory {
  for (const [re, cat] of CATEGORY) if (re.test(tag.local)) return cat;
  return "custom";
}

function toComponent(tag: SfTag): ScreenComponentInfo {
  const events = Object.entries(tag.attrs)
    .filter(([a, v]) => /^(?:on\w+|action|press)$/.test(a) && /\{!/.test(v))
    .map(([a]) => a);
  return {
    name: tag.attrs["aura:id"] ?? tag.attrs["id"] ?? tag.name,
    componentType: tag.name,
    category: categoryOf(tag),
    caption: tag.attrs["title"] ?? tag.attrs["label"] ?? tag.attrs["value"] ?? null,
    position: null,
    align: null,
    visible: true,
    children: tag.children.filter((c) => !/^aura:(?:attribute|handler|registerEvent|dependency|method)$/.test(c.name)).map(toComponent),
    events,
    dataBindings: [],
    line: tag.line,
  };
}

export function extractSfScreens(source: string, filePath: string): ScreenInfo[] {
  const { root } = parseSfMarkup(source);
  const kind = kindOf(root);
  if (!root || !kind) return [];
  const stem = filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.\w+$/, "");
  const { controller } = bindingsOf(root);
  return [
    {
      name: stem,
      formType: root.name,
      caption: root.attrs["title"] ?? null,
      dimensions: null,
      components: root.children.filter((c) => !/^aura:(?:attribute|handler|registerEvent|dependency|method)$/.test(c.name)).map(toComponent),
      filePath,
      routePath: null,
      navigatesTo: [],
      ...(controller ? { viewModel: controller } : {}),
    },
  ];
}

/** Nested custom components: `<c:clubCard />` in the same namespace. */
export function extractSfSubComponents(source: string): SubComponentInfo[] {
  const { flat } = parseSfMarkup(source);
  return flat.filter((t) => t.prefix === "c" && /^[A-Za-z]/.test(t.local)).map((t) => ({ name: t.local, importSource: null, props: Object.keys(t.attrs), line: t.line }));
}

// ─── What the file states for the resolver ────────────────────────────────

/** What a Visualforce binding's call carries in its `target`. */
export const VF_BINDING_TARGET = "vf-binding:";
/** `Controller(ClubController)` / `Extension(ClubExtension)` on the file's `<setup>`. */
export const CONTROLLER_DECORATOR = "Controller";
export const EXTENSION_DECORATOR = "Extension";

/** Words in a Visualforce expression that are functions, operators or literals, never a member of the controller. */
const EXPRESSION_WORDS: ReadonlySet<string> = new Set([
  "true", "false", "null", "and", "or", "not", "if", "case", "blankvalue", "isblank", "isnull", "nullvalue", "len", "text", "value", "contains",
  "begins", "left", "right", "mid", "lower", "upper", "trim", "round", "floor", "ceiling", "abs", "max", "min", "mod", "today", "now",
  "urlfor", "includes", "isnumber", "substitute", "tostring", "datevalue", "datetimevalue",
]);

/** The identifiers an expression reads as the head of a path (`clubs[0].Name` → `clubs`); a name before `(` is a function. */
export function expressionHeads(expression: string): string[] {
  const text = expression.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " ");
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])([A-Za-z_]\w*)(?!\w)/g)) {
    const after = text.slice(m.index! + m[0].length);
    if (/^\s*\(/.test(after) || EXPRESSION_WORDS.has(m[1]!.toLowerCase())) continue;
    out.push(m[1]!);
  }
  return out;
}

const EXPRESSION = /\{!([^{}]*)\}/g;

/**
 * Runs once the file is analysed: the controller and extensions the root names, and — on a Visualforce page — the
 * members its expressions read (`{!clubs}`, `rendered="{!canEdit}"`), each a call in the file's `<setup>` at the line it is read.
 * A variable a tag declares (`var="c"` on an iteration) and a global (`$User`) are no members.
 */
export function addSfFacts(analysis: FileAnalysis, source: string): void {
  const { root, flat } = parseSfMarkup(source);
  const kind = kindOf(root);
  if (!root || !kind) return;
  const { controller, extensions } = bindingsOf(root);
  const decorators = [
    ...(controller ? [`${CONTROLLER_DECORATOR}(${controller})`] : []),
    ...extensions.map((e) => `${EXTENSION_DECORATOR}(${e})`),
  ];
  const calls: CallInfo[] = [];
  if (kind === "visualforce") {
    const declared = new Set(flat.flatMap((t) => [t.attrs["var"]].filter((v): v is string => !!v)));
    const seen = new Set<string>();
    for (const tag of flat) {
      for (const [attr, value] of Object.entries(tag.attrs)) {
        if (attr === "action") continue;
        for (const m of value.matchAll(EXPRESSION)) {
          // Every path an expression reads (`{!canEdit && hasClubs}`), each member once, at its first line.
          for (const head of expressionHeads(m[1]!)) {
            if (declared.has(head) || seen.has(head)) continue;
            seen.add(head);
            calls.push({ name: head, kind: "cross-file", target: `${VF_BINDING_TARGET}${head}`, line: tag.line, column: tag.column, argCount: 0, confidence: "EXTRACTED" });
          }
        }
      }
    }
  }
  if (decorators.length === 0 && calls.length === 0) return;
  const setup = analysis.functions.find((f) => f.name === "<setup>");
  if (setup) {
    setup.decorators = [...setup.decorators, ...decorators];
    setup.calls.push(...calls);
  } else {
    const lines = source.split("\n").length;
    analysis.functions.unshift({ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators, calls, line: 1, endLine: lines });
  }
}

export const sfmarkupSpec: RegexLangSpec = {
  language: "sfmarkup",
  extensions: [".cmp", ".page", ".component"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],

  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],

  extractScreens: (lines, filePath) => extractSfScreens(lines.join("\n"), filePath),
  extractInteractiveElements: (lines) => extractSfInteractiveElements(lines.join("\n")),
  extractSubComponents: (lines) => extractSfSubComponents(lines.join("\n")),
};
