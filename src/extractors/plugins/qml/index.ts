import type {
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
  SubComponentInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * QML (Qt Quick) extraction — the UI tier of modern Qt desktop apps.
 *
 * A `.qml` file declares ONE component: a tree of instantiated child components
 * (`Rectangle { … }`, `Skin.Button { … }`) with property bindings, signal
 * handlers (`onClicked: …`), and inline JS `function`s. There are no routes —
 * navigation happens through `Loader { source: "X.qml" }` and
 * `StackView.push("X.qml")` — so each file becomes a screen (the Delphi-DFM
 * analog), child component tags feed `componentUsage`, and interaction signal
 * handlers become interactive elements for the click-trace funnel.
 */

// ─── Structure scan (shared by screens / subComponents / interactive) ───────

/** `Tag {` or `prop: Tag {` — a component instantiation opening a block. Every
 *  dotted segment must be Capitalized: `Skin.Button` is a component, while
 *  `Drag.mimeData: {…}` and `Component.onCompleted: {…}` are bindings. */
const COMPONENT_OPEN_RE = /^\s*(?:[a-z_]\w*\s*:\s*)?([A-Z]\w*(?:\.[A-Z]\w*)*)\s*\{\s*$/;

/** `onClicked:` / `Keys.onPressed:` signal-handler binding. */
const HANDLER_RE = /^\s*(?:([A-Z]\w*(?:\.[A-Z]\w*)*)\.)?on([A-Z]\w*)\s*:\s*(.*)$/;

/** `id: root` binding. */
const ID_RE = /^\s*id\s*:\s*([a-zA-Z_]\w*)\s*$/;

/** User-interaction signals worth surfacing (property-change spam like
 *  `onWidthChanged` is not an interaction). */
const INTERACTION_SIGNALS = new Set([
  "clicked", "doubleclicked", "pressed", "released", "pressandhold",
  "toggled", "activated", "accepted", "rejected", "editingfinished",
  "textedited", "valuechanged", "moved", "checkedchanged",
  "currentindexchanged", "wheel", "triggered",
]);

/** Attached-handler prefixes that are lifecycle, not interaction. */
const LIFECYCLE_PREFIXES = new Set(["Component"]);

const CATEGORY_BY_TAG: Array<[RegExp, ScreenComponentCategory]> = [
  [/(Button|MenuItem|CheckBox|RadioButton|Switch|MouseArea|TapHandler)$/, "action"],
  [/(TextField|TextInput|TextArea|SpinBox|Slider|Dial|ComboBox|Knob|Fader)$/, "input"],
  [/(Label|Text|Image|Icon|Shape|Canvas|DropShadow|Glow|Rectangle)$/, "display"],
  [/(ListView|GridView|TableView|TreeView|Repeater|PathView)$/, "data"],
  [/(StackView|SwipeView|Loader|Drawer|Menu|Popup|Dialog|Window)$/, "navigation"],
  [/(Item|Row|Column|Grid|Flow|Flickable|ScrollView|Frame|Pane|Layout|Group)$/, "container"],
];

function categoryOf(tag: string): ScreenComponentCategory {
  const leaf = tag.split(".").pop()!;
  for (const [re, cat] of CATEGORY_BY_TAG) if (re.test(leaf)) return cat;
  return "custom";
}

const ELEMENT_BY_CATEGORY: Record<string, InteractiveElementInfo["element"]> = {
  action: "button",
  input: "input",
  navigation: "custom",
};

interface QmlNode {
  tag: string;
  id: string | null;
  line: number;
  children: QmlNode[];
  events: string[];
  handlers: { signal: string; expr: string; line: number; attached: string | null }[];
}

interface QmlStructure {
  root: QmlNode | null;
  /** Every component open in document order (including the root). */
  flat: QmlNode[];
}

/** Net brace depth change of a line, ignoring braces inside strings/comments. */
function braceDelta(rawLine: string): number {
  const line = rawLine
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "")
    .replace(/\/\/.*$/, "");
  let d = 0;
  for (const ch of line) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/** One pass over the file, building the component tree + handler sites. */
export function parseQmlStructure(rawLines: string[]): QmlStructure {
  // CRLF sources: `\r` survives a `\n` split, and `$`-anchored patterns with
  // `.` (HANDLER_RE's `(.*)$`) never match a line ending in `\r`.
  const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const flat: QmlNode[] = [];
  let root: QmlNode | null = null;
  // Stack entries pair a node with the brace depth at which it closes.
  const stack: { node: QmlNode; depth: number }[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

    const top = stack[stack.length - 1]?.node;

    const open = line.match(COMPONENT_OPEN_RE);
    if (open) {
      const node: QmlNode = { tag: open[1]!, id: null, line: i + 1, children: [], events: [], handlers: [] };
      if (top) top.children.push(node);
      else if (!root) root = node;
      flat.push(node);
      stack.push({ node, depth });
      depth += braceDelta(line);
      continue;
    }

    const id = top ? line.match(ID_RE) : null;
    if (id && top) top.id = id[1]!;

    const handler = top ? line.match(HANDLER_RE) : null;
    if (handler && top) {
      const attached = handler[1] ?? null;
      const signal = handler[2]!;
      if (!attached || !LIFECYCLE_PREFIXES.has(attached)) {
        // A block-bodied handler (`onClicked: {`) has its statements on the
        // following lines — fold a bounded window into the expression so the
        // called function is discoverable.
        let expr = handler[3] ?? "";
        if (/^\{\s*$/.test(expr.trim()) || expr.trim() === "") {
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            expr += " " + lines[j]!.trim();
            if (braceDelta(lines[j]!) < 0) break;
          }
        }
        top.events.push("on" + signal);
        top.handlers.push({ signal, expr, line: i + 1, attached });
      }
    }

    depth += braceDelta(line);
    while (stack.length > 0 && depth <= stack[stack.length - 1]!.depth) {
      stack.pop();
    }
  }
  return { root, flat };
}

// ─── Interactive elements ────────────────────────────────────────────────────

/** A called function name from a handler expression, if one is discernible. */
function handlerTarget(expr: string): string | null {
  const trimmed = expr.trim().replace(/^\{/, "").trim();
  const call = trimmed.match(/([A-Za-z_][\w.]*)\s*\(/);
  if (call) return call[1]!.split(".").pop()!;
  const ident = trimmed.match(/^([A-Za-z_][\w.]*)$/);
  if (ident) return ident[1]!.split(".").pop()!;
  return null;
}

function extractQmlInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const { flat } = parseQmlStructure(lines);
  const out: InteractiveElementInfo[] = [];
  for (const node of flat) {
    for (const h of node.handlers) {
      if (!INTERACTION_SIGNALS.has(h.signal.toLowerCase())) continue;
      out.push({
        element: ELEMENT_BY_CATEGORY[categoryOf(node.tag)] ?? "custom",
        event: h.signal.charAt(0).toLowerCase() + h.signal.slice(1),
        handler: handlerTarget(h.expr) ?? node.id,
        line: h.line,
        component: node.tag.split(".").pop()!,
      });
    }
  }
  return out;
}

// ─── Sub-components (usage graph) ────────────────────────────────────────────

function extractQmlSubComponents(lines: string[]): SubComponentInfo[] {
  const { root, flat } = parseQmlStructure(lines);
  const seen = new Set<string>();
  const out: SubComponentInfo[] = [];
  for (const node of flat) {
    if (node === root) continue; // the file IS the root component, not a usage
    // Leaf name joins against sibling `.qml` files (`Skin.Button` → Button.qml).
    const name = node.tag.split(".").pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, importSource: null, props: [], line: node.line });
  }
  return out;
}

// ─── Screens ─────────────────────────────────────────────────────────────────

function toScreenComponent(node: QmlNode): ScreenComponentInfo {
  return {
    name: node.id ?? node.tag.split(".").pop()!,
    componentType: node.tag,
    category: categoryOf(node.tag),
    caption: null,
    position: null,
    align: null,
    visible: true,
    children: node.children.map(toScreenComponent),
    events: node.events,
    dataBindings: [],
    line: node.line,
  };
}

/** `Loader { source: "X.qml" }`, `stack.push("X.qml")`, `setSource("X.qml")`. */
const NAVIGATE_RE = /(?:\bsource\s*:|\.push\s*\(|setSource\s*\()\s*"([^"]+\.qml)"/g;

function extractQmlScreens(lines: string[], filePath: string): ScreenInfo[] {
  const { root } = parseQmlStructure(lines);
  if (!root) return [];

  const navigatesTo = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(NAVIGATE_RE)) navigatesTo.add(m[1]!);
  }

  const base = filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.qml$/i, "");
  return [
    {
      name: base,
      formType: root.tag,
      caption: null,
      dimensions: null,
      components: root.children.map(toScreenComponent),
      filePath,
      routePath: null,
      navigatesTo: [...navigatesTo],
    },
  ];
}

// ─── Spec ────────────────────────────────────────────────────────────────────

export const qmlSpec: RegexLangSpec = {
  language: "qml",
  extensions: [".qml"],
  blockStyle: "brace",
  lineCommentPrefixes: ["//"],

  // Inline JS functions declared on the component.
  functionPatterns: [
    {
      pattern: /^\s*function\s+([A-Za-z_]\w*)\s*\(/,
      isExported: () => true,
      isAsync: (line) => /\basync\s+function\b/.test(line),
    },
  ],
  classPatterns: [],

  importPatterns: [
    {
      // `import "Theme"` / `import "../Skins" as Skin` — local directory or JS file.
      pattern: /^\s*import\s+"([^"]+)"(?:\s+as\s+(\w+))?/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => (m[2] ? [m[2]] : []),
    },
    {
      // `import QtQuick.Controls 2.12` — module import.
      pattern: /^\s*import\s+([A-Za-z][\w.]*)/,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractSubComponents: extractQmlSubComponents,
  extractInteractiveElements: extractQmlInteractiveElements,
  extractScreens: (lines, filePath) => extractQmlScreens(lines, filePath),
};
