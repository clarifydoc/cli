import type {
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
} from "../../../types/analysis.js";

/**
 * WinForms UI extraction — the C# analog of the Qt pair (qtui Designer forms +
 * cpp connect() wiring).
 *
 * Two sources, both plain C# statements:
 *   1. Event subscriptions: `MnuOpenFile.Click += MnuOpenFile_Click;` (modern
 *      Designer style) or `this.button1.Click += new System.EventHandler(this.button1_Click);`
 *      (legacy style). These appear in `*.Designer.cs` `InitializeComponent()`
 *      AND in hand-wired form code, so the extractor runs on every C# file and
 *      gates on the event name instead of the file name.
 *   2. The Designer file itself is a full form description: control
 *      declarations (`Toolbar = new ModernToolbar();`), containment
 *      (`Controls.Add(PicMain)`, `MnuFile.DropDownItems.AddRange(new … { … })`),
 *      captions (`Text = "ImageGlass"`), and geometry — one ScreenInfo per form.
 *
 * The handler method lives in the OTHER half of the partial class (FrmMain.cs
 * vs FrmMain.Designer.cs), so these elements alone dead-end; the
 * CsharpUiBridgeResolver (ui-bridge.ts) adds the synthetic wiring→handler
 * symbol links that make click traces resolve.
 */

/** Events that are user interactions on any receiver. */
const STRONG_UI_EVENTS = new Set([
  "Click", "DoubleClick", "MouseClick", "MouseDoubleClick", "MouseDown", "MouseUp",
  "ItemClicked", "ButtonClick", "LinkClicked", "CellClick", "CellDoubleClick",
  "CellContentClick", "NodeMouseClick", "NodeMouseDoubleClick", "ItemActivate",
  "DoubleTapped", "Tapped", "KeyDown", "KeyUp", "KeyPress",
  "TextChanged", "SelectedIndexChanged", "SelectedValueChanged", "SelectionChanged",
  "CheckedChanged", "CheckStateChanged", "ValueChanged", "Scroll",
  "DragDrop", "LostFocus", "Validated",
]);

/** Events that are interactions only on a control-shaped receiver (menus
 *  opening, drop-downs) — they also exist on non-UI classes. */
const WEAK_UI_EVENTS = new Set([
  "Opening", "Opened", "DropDownOpening", "DropDownItemClicked", "DropDownClosed",
  "MouseEnter", "MouseLeave", "MouseWheel", "MouseMove",
]);

const CONTROL_NAME_RE =
  /(btn|button|mnu|menu|tool|txt|text|lbl|label|cmb|combo|chk|check|rad|radio|lst|list|grid|tree|tab|nud|numeric|slider|track|picker|pic|img|link|panel|strip|gallery|canvas|view|bar)/i;

const ELEMENT_BY_NAME: Array<[RegExp, InteractiveElementInfo["element"]]> = [
  [/btn|button|mnu|menu|tool|chk|check|rad|radio|link/i, "button"],
  [/cmb|combo|lst|list/i, "select"],
  [/txt|text|nud|numeric|slider|track|picker/i, "input"],
];

function elementOf(receiver: string, event: string): InteractiveElementInfo["element"] {
  for (const [re, el] of ELEMENT_BY_NAME) if (re.test(receiver)) return el;
  if (/Click|Tapped/i.test(event)) return "button";
  if (/TextChanged|KeyPress|KeyDown|KeyUp/.test(event)) return "input";
  if (/Selected/.test(event)) return "select";
  return "custom";
}

/**
 * One `receiver.Event += Handler;` statement. RHS forms handled:
 *   `Handler;`  ·  `this.Handler;`  ·  `new System.EventHandler(this.Handler);`
 * Lambdas / delegate literals have no resolvable method name and are skipped.
 */
const EVENT_SUB_RE =
  /^\s*(?:this\.)?([A-Za-z_][\w.]*)\s*\+=\s*(?:new\s+[\w.]+\s*\(\s*)?(?:this\.)?([A-Za-z_][\w.]*)\s*\)?\s*;/;

interface EventWiring {
  receiver: string;
  event: string;
  handler: string;
  line: number;
}

/** All `X.Event += Handler` subscriptions in the file, ungated (screens want
 *  lifecycle events too — `interactive` gating happens in the caller). */
export function extractEventWirings(lines: string[]): EventWiring[] {
  const out: EventWiring[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(EVENT_SUB_RE);
    if (!m) continue;
    const lhs = m[1]!;
    const rhsLeaf = m[2]!.split(".").pop()!;
    const dot = lhs.lastIndexOf(".");
    // Receiver-less form (`Load += FrmMain_Load;`): the form itself is the receiver.
    const receiver = dot === -1 ? "" : lhs.slice(0, dot).split(".").pop()!;
    const event = dot === -1 ? lhs : lhs.slice(dot + 1);
    // The event must look like an event name and the handler like a method.
    if (!/^[A-Z]/.test(event) || !/^[A-Za-z_]\w*$/.test(rhsLeaf)) continue;
    out.push({ receiver, event, handler: rhsLeaf, line: i + 1 });
  }
  return out;
}

/** Interactive elements from event subscriptions (strong/weak gated). */
export function extractWinFormsInteractiveElements(sourceText: string): InteractiveElementInfo[] {
  const lines = sourceText.split("\n");
  const out: InteractiveElementInfo[] = [];
  for (const w of extractEventWirings(lines)) {
    const strong = STRONG_UI_EVENTS.has(w.event);
    const weak = WEAK_UI_EVENTS.has(w.event) && CONTROL_NAME_RE.test(w.receiver);
    if (!strong && !weak) continue;
    out.push({
      element: elementOf(w.receiver, w.event),
      event: w.event,
      handler: w.handler,
      line: w.line,
      component: w.receiver || "form",
    });
  }
  return out;
}

// ─── Designer-file screens ─────────────────────────────────────────────────

const CATEGORY_BY_TYPE: Array<[RegExp, ScreenComponentCategory]> = [
  [/(Button|CheckBox|RadioButton)$/, "action"],
  [/(TextBox|ComboBox|NumericUpDown|TrackBar|DateTimePicker|DomainUpDown|Slider|ColorPicker)$/, "input"],
  [/(Label|PictureBox|ProgressBar|WebView2?|Chart)$/, "display"],
  [/(ListView|DataGridView|TreeView|ListBox|CheckedListBox|Gallery|PropertyGrid)$/, "data"],
  [/(MenuStrip|ToolStrip|StatusStrip|TabControl|ToolStripMenuItem|ToolStripSeparator|ToolStripButton|ContextMenuStrip|Menu)$/, "navigation"],
  [/(Panel|GroupBox|SplitContainer|Splitter|UserControl|Form)$/, "container"],
];

function categoryOf(type: string): ScreenComponentCategory {
  for (const [re, cat] of CATEGORY_BY_TYPE) if (re.test(type)) return cat;
  return "custom";
}

interface DesignerModel {
  className: string | null;
  baseType: string | null;
  caption: string | null;
  dimensions: { width: number; height: number } | null;
  /** control name → new'd type (leaf). */
  types: Map<string, string>;
  declLine: Map<string, number>;
  captions: Map<string, string>;
  position: Map<string, { left: number; top: number; width: number; height: number }>;
  /** child → parent ("" = the form). */
  parentOf: Map<string, string>;
  events: Map<string, string[]>;
}

const NEW_DECL_RE = /^\s*(?:this\.)?(\w+) = new ([\w.]+)\s*\(/;
/** Value-type constructions (`ClientSize = new Size(…)`, `Font = new Font(…)`)
 *  are form/control PROPERTY assignments, not control declarations. */
const VALUE_TYPE_RE =
  /^(Size|SizeF|Point|PointF|Font|Padding|Icon|Rectangle|RectangleF|Color|ColumnStyle|RowStyle|Bitmap|Margins|StringFormat|EventHandler|Cursor)$/;
const FIELD_DECL_RE = /^\s*(?:private|protected|internal|public)\s+(?:readonly\s+)?([\w.]+(?:<[\w.,\s<>]*>)?)\s+(\w+)\s*;\s*$/;
const CTRL_TEXT_RE = /^\s*(?:this\.)?(\w+)\.Text = "((?:[^"\\]|\\.)*)"\s*;/;
const FORM_TEXT_RE = /^\s*(?:this\.)?Text = "((?:[^"\\]|\\.)*)"\s*;/;
const CLIENT_SIZE_RE = /^\s*(?:this\.)?ClientSize = new (?:System\.Drawing\.)?Size\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/;
const LOCATION_RE = /^\s*(?:this\.)?(\w+)\.Location = new (?:System\.Drawing\.)?Point\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/;
const SIZE_RE = /^\s*(?:this\.)?(\w+)\.Size = new (?:System\.Drawing\.)?Size\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/;
const ADD_RE = /^\s*(?:this\.)?([\w.]+?)?\.?Controls\.Add\s*\(\s*(?:this\.)?(\w+)\s*[,)]/;
const ADD_RANGE_RE = /^\s*(?:this\.)?([\w.]+?)?\.?(Controls|Items|DropDownItems)\.AddRange\s*\(/;

/** Right-most path segment that names a declared control (`Split.Panel1` → `Split`). */
function ownerControl(path: string | undefined, types: Map<string, string>): string {
  if (!path) return "";
  const segs = path.split(".");
  for (let i = segs.length - 1; i >= 0; i--) {
    if (types.has(segs[i]!)) return segs[i]!;
  }
  return segs[0]!;
}

export function parseDesignerFile(lines: string[]): DesignerModel {
  const m: DesignerModel = {
    className: null, baseType: null, caption: null, dimensions: null,
    types: new Map(), declLine: new Map(), captions: new Map(),
    position: new Map(), parentOf: new Map(), events: new Map(),
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (m.className === null) {
      const cm = line.match(/\bpartial class (\w+)(?:\s*:\s*([\w.]+))?/);
      if (cm) {
        m.className = cm[1]!;
        m.baseType = cm[2]?.split(".").pop() ?? null;
      }
    }

    const decl = line.match(NEW_DECL_RE);
    if (decl && !VALUE_TYPE_RE.test(decl[2]!.split(".").pop()!)) {
      if (!m.types.has(decl[1]!)) {
        m.types.set(decl[1]!, decl[2]!.split(".").pop()!);
        m.declLine.set(decl[1]!, i + 1);
      }
      continue;
    }
    const field = line.match(FIELD_DECL_RE);
    if (field && !m.types.has(field[2]!) && field[2] !== "components") {
      m.types.set(field[2]!, field[1]!.split(".").pop()!.replace(/<.*$/, ""));
      m.declLine.set(field[2]!, i + 1);
      continue;
    }

    // Form caption first: `this.Text = "…"` would otherwise be captured by the
    // control regex with the phantom receiver "this".
    const ft = line.match(FORM_TEXT_RE);
    if (ft) { m.caption = ft[1]!; continue; }
    const ct = line.match(CTRL_TEXT_RE);
    if (ct) { m.captions.set(ct[1]!, ct[2]!); continue; }

    const cs = line.match(CLIENT_SIZE_RE);
    if (cs) { m.dimensions = { width: Number(cs[1]), height: Number(cs[2]) }; continue; }
    const loc = line.match(LOCATION_RE);
    if (loc) {
      const p = m.position.get(loc[1]!) ?? { left: 0, top: 0, width: 0, height: 0 };
      p.left = Number(loc[2]); p.top = Number(loc[3]);
      m.position.set(loc[1]!, p);
      continue;
    }
    const sz = line.match(SIZE_RE);
    if (sz) {
      const p = m.position.get(sz[1]!) ?? { left: 0, top: 0, width: 0, height: 0 };
      p.width = Number(sz[2]); p.height = Number(sz[3]);
      m.position.set(sz[1]!, p);
      continue;
    }

    const add = line.match(ADD_RE);
    if (add) {
      const parent = ownerControl(add[1], m.types);
      if (!m.parentOf.has(add[2]!)) m.parentOf.set(add[2]!, parent);
      continue;
    }

    const ar = line.match(ADD_RANGE_RE);
    if (ar) {
      const parent = ownerControl(ar[1], m.types);
      // Fold the statement (the item array may span lines) and take every
      // identifier that names a DECLARED control — type tokens (`new
      // ToolStripItem[]`) are naturally excluded because they aren't declared.
      let stmt = "";
      for (let j = i; j < Math.min(i + 200, lines.length); j++) {
        stmt += " " + lines[j]!;
        if (/\)\s*;/.test(lines[j]!)) break;
      }
      const brace = stmt.indexOf("{");
      if (brace === -1) continue; // AddRange(someVariable) — nothing to attribute
      const body = stmt.slice(brace + 1);
      for (const idm of body.matchAll(/(?:this\.)?([A-Za-z_]\w*)/g)) {
        const child = idm[1]!;
        if (m.types.has(child) && !m.parentOf.has(child) && child !== parent) {
          m.parentOf.set(child, parent);
        }
      }
      continue;
    }
  }

  for (const w of extractEventWirings(lines)) {
    if (!w.receiver) continue;
    const list = m.events.get(w.receiver) ?? [];
    list.push(w.event);
    m.events.set(w.receiver, list);
  }

  return m;
}

function toComponent(name: string, m: DesignerModel, childrenOf: Map<string, string[]>): ScreenComponentInfo {
  const type = m.types.get(name) ?? "Control";
  const pos = m.position.get(name);
  return {
    name,
    componentType: type,
    category: categoryOf(type),
    caption: m.captions.get(name) ?? null,
    position: pos && (pos.width > 0 || pos.left > 0 || pos.top > 0) ? pos : null,
    align: null,
    visible: true,
    children: (childrenOf.get(name) ?? []).map((c) => toComponent(c, m, childrenOf)),
    events: m.events.get(name) ?? [],
    dataBindings: [],
    line: m.declLine.get(name) ?? 0,
  };
}

/**
 * One ScreenInfo per `*.Designer.cs` form. Gated on the generated
 * `InitializeComponent()` body so `Resources.Designer.cs` (resx codegen, no
 * form) never produces a phantom screen.
 */
export function extractWinFormsScreens(sourceText: string, filePath: string): ScreenInfo[] {
  if (!/\.Designer\.cs$/i.test(filePath)) return [];
  if (!/void InitializeComponent\s*\(\s*\)/.test(sourceText)) return [];
  const lines = sourceText.split("\n");
  const m = parseDesignerFile(lines);
  if (!m.className || m.types.size === 0) return [];

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const name of m.types.keys()) {
    const parent = m.parentOf.get(name);
    if (parent === undefined || parent === "" || !m.types.has(parent)) {
      roots.push(name);
    } else {
      const list = childrenOf.get(parent) ?? [];
      list.push(name);
      childrenOf.set(parent, list);
    }
  }

  return [
    {
      name: m.className,
      formType: m.baseType ?? "Form",
      caption: m.caption,
      dimensions: m.dimensions,
      components: roots.map((r) => toComponent(r, m, childrenOf)),
      filePath,
      routePath: null,
      navigatesTo: [],
    },
  ];
}
