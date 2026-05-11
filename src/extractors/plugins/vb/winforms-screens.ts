import type {
  ClassInfo,
  ScreenInfo,
  ScreenComponentInfo,
  ScreenComponentCategory,
} from "../../../types/analysis.js";

/**
 * Extract ScreenInfo from VB.NET WinForms designer code.
 *
 * Looks for `InitializeComponent()` methods (or any method that constructs controls)
 * and extracts the declared controls, their properties, and event handler wiring.
 *
 * Designer-style VB.NET patterns recognized:
 *   Dim lblEmail As New Label With {.Text = "Email:", .Left = 20, .Top = 20, .Width = 80}
 *   txtEmail = New TextBox With {.Left = 100, .Top = 18, .Width = 200}
 *   btnLogin.Text = "Login"
 *   Me.Text = "Sign in"
 *   Private Sub btnLogin_Click(...) Handles btnLogin.Click
 */

/** Map WinForms control types to screen component categories */
const WINFORMS_CATEGORY_MAP: Record<string, ScreenComponentCategory> = {
  // Containers
  Form: "container", Panel: "container", GroupBox: "container",
  TabControl: "container", TabPage: "container", SplitContainer: "container",
  TableLayoutPanel: "container", FlowLayoutPanel: "container",
  UserControl: "container", ToolStrip: "container", StatusStrip: "container",
  MenuStrip: "container",
  // Inputs
  TextBox: "input", RichTextBox: "input", MaskedTextBox: "input",
  ComboBox: "input", CheckBox: "input", RadioButton: "input",
  NumericUpDown: "input", DateTimePicker: "input", MonthCalendar: "input",
  TrackBar: "input", DomainUpDown: "input", ColorDialog: "input",
  // Display
  Label: "display", LinkLabel: "display", PictureBox: "display",
  ProgressBar: "display", ToolTip: "display",
  // Data
  DataGridView: "data", ListView: "data", ListBox: "data",
  TreeView: "data", BindingSource: "data", BindingNavigator: "data",
  // Action
  Button: "action", ToolStripButton: "action", ToolStripMenuItem: "action",
  // Navigation
  ToolStripDropDown: "navigation",
};

/** Visual props we track when seen on designer lines */
const VISUAL_PROPS = new Set([
  "Text", "Caption", "Left", "Top", "Width", "Height",
  "Name", "Visible", "Enabled", "Dock", "Anchor",
  "ForeColor", "BackColor", "Font", "PasswordChar",
  "DropDownStyle", "AutoSizeColumnsMode",
]);

function resolveCategory(componentType: string): ScreenComponentCategory {
  return WINFORMS_CATEGORY_MAP[componentType] ?? "custom";
}

interface Control {
  name: string;
  componentType: string;
  line: number;
  props: Map<string, string>;
  events: string[];
}

function parseWithInit(withBlock: string): Map<string, string> {
  // Parse `{.Prop = value, .Prop2 = value2}` — handles simple scalar values and
  // nested `With { ... }` expressions crudely.
  const props = new Map<string, string>();
  // Strip outer braces if present
  const body = withBlock.replace(/^\s*\{/, "").replace(/\}\s*$/, "");

  // Split on top-level commas (not inside nested braces/parens)
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let strCh = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === strCh && body[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  for (const part of parts) {
    const m = part.match(/^\s*\.(\w+)\s*=\s*(.+?)\s*$/);
    if (m) {
      const value = m[2].replace(/^"(.*)"[cC]?$/, "$1").replace(/^"(.*)"$/, "$1");
      props.set(m[1], value);
    }
  }
  return props;
}

function parseIntProp(props: Map<string, string>, key: string): number | null {
  const v = props.get(key);
  if (!v) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

export function extractWinFormsScreens(
  lines: string[],
  filePath: string,
  classes: ClassInfo[],
): ScreenInfo[] {
  const screens: ScreenInfo[] = [];

  for (const cls of classes) {
    // Only classes that extend Form are forms
    if (!cls.extends || !/Form$/.test(cls.extends)) continue;

    const controls = new Map<string, Control>();
    const formProps = new Map<string, string>();
    const handlesMap: { control: string; event: string; handler: string }[] = [];

    // Scan within the class body
    for (let i = cls.line - 1; i < cls.endLine && i < lines.length; i++) {
      const line = lines[i];

      // `Dim NAME As New TYPE With { ... }` or `NAME = New TYPE With { ... }`
      const declMatch = line.match(/(?:Dim\s+|(?:Me\.)?)(\w+)\s+As\s+New\s+(\w+)(?:\s+With\s*(\{[^}]*\}))?/i)
        ?? line.match(/^\s*(\w+)\s*=\s*New\s+(\w+)(?:\s+With\s*(\{[^}]*\}))?/i);
      if (declMatch) {
        const name = declMatch[1];
        const componentType = declMatch[2];
        const withBlock = declMatch[3] ?? "";
        const props = withBlock ? parseWithInit(withBlock) : new Map<string, string>();
        controls.set(name, {
          name,
          componentType,
          line: i + 1,
          props,
          events: [],
        });
        continue;
      }

      // `Me.Prop = value` — form-level property
      const meProp = line.match(/^\s*Me\.(\w+)\s*=\s*(.+?)\s*$/);
      if (meProp && VISUAL_PROPS.has(meProp[1])) {
        const value = meProp[2].replace(/^"(.*)"[cC]?$/, "$1").replace(/^"(.*)"$/, "$1");
        formProps.set(meProp[1], value);
      }

      // `ctrl.Prop = value` — control property setters outside With block
      const ctrlProp = line.match(/^\s*(\w+)\.(\w+)\s*=\s*(.+?)\s*$/);
      if (ctrlProp && controls.has(ctrlProp[1]) && VISUAL_PROPS.has(ctrlProp[2])) {
        const value = ctrlProp[3].replace(/^"(.*)"[cC]?$/, "$1").replace(/^"(.*)"$/, "$1");
        controls.get(ctrlProp[1])!.props.set(ctrlProp[2], value);
      }
    }

    // Find event bindings via `Handles ctrl.Event` clauses in methods
    for (const method of cls.methods) {
      for (let i = method.line - 1; i < Math.min(method.line + 2, lines.length); i++) {
        const line = lines[i];
        const handlesRe = /\bHandles\s+(.+?)(?:$|\s*(?:'|\n))/i;
        const m = line.match(handlesRe);
        if (m) {
          // Multiple handlers can be comma-separated: "Handles btnA.Click, btnB.Click"
          for (const entry of m[1].split(",").map((s) => s.trim())) {
            const [ctrl, evt] = entry.split(".");
            if (ctrl && evt) {
              handlesMap.push({ control: ctrl, event: evt, handler: method.name });
            }
          }
        }
      }
    }

    // Attach event handlers to controls
    for (const h of handlesMap) {
      const ctrl = controls.get(h.control);
      if (ctrl) {
        ctrl.events.push(`${h.event} → ${h.handler}`);
      }
    }

    // If no controls were found, skip — this isn't really a form-based class
    if (controls.size === 0 && !formProps.has("Text")) continue;

    // Build ScreenComponentInfo list
    const components: ScreenComponentInfo[] = [];
    for (const ctrl of controls.values()) {
      const left = parseIntProp(ctrl.props, "Left");
      const top = parseIntProp(ctrl.props, "Top");
      const width = parseIntProp(ctrl.props, "Width");
      const height = parseIntProp(ctrl.props, "Height");

      components.push({
        name: ctrl.name,
        componentType: ctrl.componentType,
        category: resolveCategory(ctrl.componentType),
        caption: ctrl.props.get("Text") ?? null,
        position: (left != null && top != null)
          ? { left, top, width: width ?? 0, height: height ?? 0 }
          : null,
        align: ctrl.props.get("Dock") ?? null,
        visible: ctrl.props.get("Visible") !== "False",
        children: [],
        events: ctrl.events,
        dataBindings: [],
        line: ctrl.line,
      });
    }

    // Form dimensions from Me.Width/Me.Height
    const formWidth = parseIntProp(formProps, "Width");
    const formHeight = parseIntProp(formProps, "Height");

    screens.push({
      name: cls.name,
      formType: cls.extends,
      caption: formProps.get("Text") ?? null,
      dimensions: (formWidth != null && formHeight != null)
        ? { width: formWidth, height: formHeight }
        : null,
      components,
      filePath,
      routePath: null,
      navigatesTo: [],
    });
  }

  return screens;
}
