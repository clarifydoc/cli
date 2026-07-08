import type {
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Qt Designer `.ui` forms (XML) — the Qt Widgets analog of Delphi's `.dfm`.
 * Each file is one dialog/window: `<class>DlgPrefEQ</class>` names it, nested
 * `<widget class="QPushButton" name="pushButtonApply">` elements are the
 * component tree, and the `<connections>` section wires widget signals to C++
 * slots (`pushButtonApply.clicked() → DlgPrefEQ.slotApply()`). The companion
 * C++ class implements those slots, so the interactive elements carry the slot
 * name as handler for the symbol linker to pick up.
 *
 * No functions/classes/imports — this is pure designer markup.
 */

const WIDGET_OPEN_RE = /<widget\s+class="([\w:]+)"(?:\s+name="([^"]*)")?\s*\/?>/;
const WIDGET_CLOSE_RE = /<\/widget>/;
const CLASS_RE = /<class>([\w:]+)<\/class>/;
const STRING_RE = /<string(?:\s[^>]*)?>([\s\S]*?)<\/string>/;

const CATEGORY_BY_CLASS: Array<[RegExp, ScreenComponentCategory]> = [
  [/^Q.*(Button|CheckBox|RadioButton)$/, "action"],
  [/^Q(LineEdit|TextEdit|PlainTextEdit|SpinBox|DoubleSpinBox|ComboBox|Slider|Dial|DateEdit|TimeEdit|DateTimeEdit|KeySequenceEdit|FontComboBox)$/, "input"],
  [/^Q(Label|LCDNumber|ProgressBar|GraphicsView|OpenGLWidget)$/, "display"],
  [/^Q(TableView|TableWidget|ListView|ListWidget|TreeView|TreeWidget|ColumnView|UndoView)$/, "data"],
  [/^Q(StackedWidget|TabWidget|ToolBox|MenuBar|Menu|StatusBar|ToolBar|DockWidget)$/, "navigation"],
  [/^Q(Widget|Dialog|MainWindow|Frame|GroupBox|ScrollArea|Splitter|MdiArea|WizardPage|Wizard)$/, "container"],
];

function categoryOf(cls: string): ScreenComponentCategory {
  for (const [re, cat] of CATEGORY_BY_CLASS) if (re.test(cls)) return cat;
  return "custom";
}

const ELEMENT_BY_CLASS: Array<[RegExp, InteractiveElementInfo["element"]]> = [
  [/Button|CheckBox|RadioButton/, "button"],
  [/ComboBox/, "select"],
  [/TextEdit|PlainTextEdit/, "textarea"],
  [/LineEdit|SpinBox|Slider|Dial/, "input"],
];

function elementOf(cls: string): InteractiveElementInfo["element"] {
  for (const [re, el] of ELEMENT_BY_CLASS) if (re.test(cls)) return el;
  return "custom";
}

interface UiNode {
  cls: string;
  name: string;
  line: number;
  children: UiNode[];
  events: string[];
}

interface UiConnection {
  sender: string;
  signal: string;
  slot: string;
  line: number;
}

interface UiStructure {
  className: string | null;
  root: UiNode | null;
  flat: UiNode[];
  connections: UiConnection[];
  caption: string | null;
  dimensions: { width: number; height: number } | null;
}

export function parseUiFile(rawLines: string[]): UiStructure {
  const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const flat: UiNode[] = [];
  const stack: UiNode[] = [];
  let root: UiNode | null = null;
  let className: string | null = null;
  let caption: string | null = null;
  let dimensions: { width: number; height: number } | null = null;

  // <connections>: sender/signal/slot triples in document order.
  const connections: UiConnection[] = [];
  let conn: Partial<UiConnection> | null = null;

  let pendingWindowTitle = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (className === null) {
      const cm = line.match(CLASS_RE);
      if (cm) className = cm[1]!;
    }

    const open = line.match(WIDGET_OPEN_RE);
    if (open) {
      const node: UiNode = { cls: open[1]!, name: open[2] ?? "", line: i + 1, children: [], events: [] };
      const top = stack[stack.length - 1];
      if (top) top.children.push(node);
      else if (!root) root = node;
      flat.push(node);
      if (!/\/>\s*$/.test(line)) stack.push(node);
      continue;
    }
    if (WIDGET_CLOSE_RE.test(line)) {
      stack.pop();
      continue;
    }

    // Root window caption: `<property name="windowTitle">` + `<string>…</string>`.
    if (/<property\s+name="windowTitle"/.test(line)) pendingWindowTitle = true;
    else if (pendingWindowTitle) {
      const sm = line.match(STRING_RE);
      if (sm) {
        if (caption === null) caption = sm[1]!.trim() || null;
        pendingWindowTitle = false;
      } else if (/<\/property>/.test(line)) {
        pendingWindowTitle = false;
      }
    }

    // Root geometry: first <width>/<height> pair while only the root is open.
    if (dimensions === null && stack.length <= 1 && root) {
      const wm = line.match(/<width>(\d+)<\/width>/);
      const hm = lines[i + 1]?.match(/<height>(\d+)<\/height>/);
      if (wm && hm) dimensions = { width: Number(wm[1]), height: Number(hm[1]) };
    }

    // Connections.
    if (/<connection>/.test(line)) conn = { line: i + 1 };
    else if (conn) {
      const sm = line.match(/<sender>([^<]*)<\/sender>/);
      const gm = line.match(/<signal>([\w]+)\s*\([^)]*\)<\/signal>/);
      const lm = line.match(/<slot>([\w]+)\s*\([^)]*\)<\/slot>/);
      if (sm) conn.sender = sm[1]!;
      if (gm) conn.signal = gm[1]!;
      if (lm) conn.slot = lm[1]!;
      if (/<\/connection>/.test(line)) {
        if (conn.sender && conn.signal && conn.slot) {
          connections.push(conn as UiConnection);
        }
        conn = null;
      }
    }
  }

  // Attach connection signals to their sender widgets as events.
  const byName = new Map(flat.filter((n) => n.name).map((n) => [n.name, n]));
  for (const c of connections) {
    byName.get(c.sender)?.events.push(c.signal);
  }

  return { className, root, flat, connections, caption, dimensions };
}

function toScreenComponent(node: UiNode): ScreenComponentInfo {
  return {
    name: node.name || node.cls,
    componentType: node.cls,
    category: categoryOf(node.cls),
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

function extractUiScreens(lines: string[], filePath: string): ScreenInfo[] {
  const ui = parseUiFile(lines);
  if (!ui.root) return [];
  const base = filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.ui$/i, "");
  return [
    {
      name: ui.className ?? base,
      formType: ui.root.cls,
      caption: ui.caption,
      dimensions: ui.dimensions,
      components: ui.root.children.map(toScreenComponent),
      filePath,
      routePath: null,
      navigatesTo: [],
    },
  ];
}

function extractUiInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const ui = parseUiFile(lines);
  const out: InteractiveElementInfo[] = [];
  const classByName = new Map(ui.flat.filter((n) => n.name).map((n) => [n.name, n.cls]));

  // Wired connections carry the real handler (the C++ slot).
  for (const c of ui.connections) {
    out.push({
      element: elementOf(classByName.get(c.sender) ?? ""),
      event: c.signal,
      handler: c.slot,
      line: c.line,
      component: classByName.get(c.sender) ?? c.sender,
    });
  }

  // Unwired buttons still surface (handler = widget name; many forms connect
  // in C++ code via connect(ui->x, …) instead of Designer connections).
  const wired = new Set(ui.connections.map((c) => c.sender));
  for (const n of ui.flat) {
    if (!n.name || wired.has(n.name)) continue;
    if (!/Button$/.test(n.cls) || !/^Q/.test(n.cls)) continue;
    out.push({ element: "button", event: "clicked", handler: n.name, line: n.line, component: n.cls });
  }
  return out;
}

export const qtuiSpec: RegexLangSpec = {
  language: "qtui",
  extensions: [".ui"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],

  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],

  extractScreens: (lines, filePath) => extractUiScreens(lines, filePath),
  extractInteractiveElements: extractUiInteractiveElements,
};
