import type { InteractiveElementInfo } from "../../../types/analysis.js";

/**
 * Qt Widgets signal wiring: `connect(Widget, &QClass::signal, this, &Dlg::slot)`.
 *
 * Mixxx-style Qt apps ship Designer `.ui` forms with NO `<connections>` — every
 * widget is wired in the C++ constructor instead. Without this extractor the
 * whole preferences/dialog layer has interactive elements (from the .ui plugin)
 * but no handlers, so click-traces dead-end at the widget. The slot named here
 * is a method of the SAME file's class, which is exactly the shape the
 * click-trace funnel resolves (handler → same-file symbol → symbolLinks → DAO).
 *
 * Handles the modern pointer-to-member form (including statements broken across
 * lines and `#if` preprocessor branches, which are skipped) and the legacy
 * `SIGNAL(clicked())` / `SLOT(slotApply())` macro form.
 */

/** Signals that are user interactions on any receiver. */
const STRONG_UI_SIGNALS = new Set([
  "clicked", "doubleClicked", "toggled", "stateChanged", "checkStateChanged",
  "currentIndexChanged", "textEdited", "editingFinished", "returnPressed",
  "sliderMoved", "sliderReleased", "itemClicked", "itemDoubleClicked",
  "itemActivated", "cellClicked", "cellDoubleClicked", "accepted", "rejected",
  "triggered", "linkActivated",
]);

/** Signals that are interactions only on a widget-shaped receiver (they also
 *  exist on non-UI classes — Mixxx's ControlObject emits valueChanged). */
const WEAK_UI_SIGNALS = new Set([
  "valueChanged", "activated", "pressed", "released", "currentTextChanged",
  "textChanged", "currentChanged", "selectionChanged",
]);

const WIDGET_NAME_RE =
  /(button|check|combo|box|slider|edit|spin|radio|dial|list|table|tree|tab|action|menu|field|input|chooser|picker)/i;

const ELEMENT_BY_NAME: Array<[RegExp, InteractiveElementInfo["element"]]> = [
  [/button|radio|check|toggle|action|menu/i, "button"],
  [/combo/i, "select"],
  [/textedit|plaintext/i, "textarea"],
  [/edit|spin|slider|dial|field|input/i, "input"],
];

function elementOf(receiver: string): InteractiveElementInfo["element"] {
  for (const [re, el] of ELEMENT_BY_NAME) if (re.test(receiver)) return el;
  return "custom";
}

/** `&QCheckBox::stateChanged` → { cls: "QCheckBox", member: "stateChanged" } */
const MEMBER_REF_RE = /&\s*([\w:]+)::(\w+)/g;
const SIGNAL_MACRO_RE = /\bSIGNAL\s*\(\s*(\w+)/;
const SLOT_MACRO_RE = /\bSLOT\s*\(\s*(\w+)/;

/** Fold a `connect(` statement into one string; skips preprocessor lines. */
function statementAt(lines: string[], start: number, col: number): { text: string } {
  let text = "";
  let depth = 0;
  let started = false;
  for (let i = start; i < Math.min(start + 15, lines.length); i++) {
    const raw = i === start ? lines[i]!.slice(col) : lines[i]!;
    if (/^\s*#/.test(raw)) continue; // #if QT_VERSION … / #else / #endif
    const line = raw.replace(/\/\/.*$/, "");
    for (const ch of line) {
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") depth--;
    }
    text += " " + line;
    if (started && depth <= 0) break;
  }
  return { text };
}

export function extractCppConnectElements(lines: string[]): InteractiveElementInfo[] {
  const out: InteractiveElementInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/(?:^|[^\w.>-])connect\s*\(/);
    if (!m) continue;
    const { text } = statementAt(lines, i, m.index ?? 0);

    // First argument = the sender. `ui->name` → name; bare identifier kept;
    // expressions (nested calls, casts) are not widgets we can name — skip.
    const openIdx = text.indexOf("(");
    const firstComma = text.indexOf(",", openIdx);
    if (openIdx < 0 || firstComma < 0) continue;
    let receiver = text.slice(openIdx + 1, firstComma).trim();
    receiver = receiver.replace(/^ui\s*->\s*/, "").replace(/^&/, "").replace(/^this->/, "");
    if (!/^[A-Za-z_]\w*$/.test(receiver) || receiver === "this") continue;

    const rest = text.slice(firstComma);
    const refs = [...rest.matchAll(MEMBER_REF_RE)];
    const sigMacro = rest.match(SIGNAL_MACRO_RE);
    const slotMacro = rest.match(SLOT_MACRO_RE);

    const signal = sigMacro?.[1] ?? refs[0]?.[2];
    // The slot is the LAST member ref — but only when it isn't the signal itself
    // (a two-arg connect to a lambda has just one ref → no resolvable handler).
    const slotRef = refs.length >= 2 ? refs[refs.length - 1] : undefined;
    const slot = slotMacro?.[1] ?? slotRef?.[2];
    if (!signal || !slot) continue;

    const strong = STRONG_UI_SIGNALS.has(signal);
    const weak = WEAK_UI_SIGNALS.has(signal) && WIDGET_NAME_RE.test(receiver);
    if (!strong && !weak) continue;

    out.push({
      element: elementOf(receiver),
      event: signal,
      handler: slot,
      line: i + 1,
      // The signal's owning class (`&QCheckBox::stateChanged`) names the widget
      // type more reliably than the receiver variable does.
      component: sigMacro ? receiver : refs[0]?.[1]?.split("::").pop() ?? receiver,
    });
  }
  return out;
}
