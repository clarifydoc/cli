import type {
  InteractiveElementInfo,
  RouteInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
  SubComponentInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * XAML UI markup — WPF `.xaml`, Avalonia `.axaml`, and the MAUI/WinUI dialects
 * (all share the tag/attribute grammar). Each file is one window/control:
 * `x:Class="Ns.MainWindow"` names the code-behind class, nested elements are
 * the component tree, and event attributes (`Click="ButtonCopy_Click"`) wire
 * controls to code-behind methods.
 *
 * Unlike Qt Designer `.ui` XML, XAML opening tags routinely span many lines
 * (one attribute per line), so extraction runs on a tag TOKENIZER over the
 * whole text, not line regexes.
 *
 * The handler lives in `<same path>.cs` (code-behind partial class), so the
 * elements alone dead-end — CsharpUiBridgeResolver adds the synthetic
 * element→handler symbol links.
 */

interface XamlTag {
  /** Tag with namespace prefix stripped (`ui:PhMenuItem` → `PhMenuItem`). */
  name: string;
  /** Namespace prefix ("" when none). */
  prefix: string;
  /** Raw tag as written (kept for property-element detection). */
  raw: string;
  attrs: Record<string, string>;
  line: number;
  children: XamlTag[];
  /** True for `<Owner.Property>` elements — transparent in the tree. */
  isProperty: boolean;
}

// Attr chunk is LAZY so the trailing `/` of a self-closing tag lands in group 4
// (`[^"'>]` would otherwise consume it and every `<X />` would stay "open").
const TAG_TOKEN_RE = /<(\/?)([A-Za-z_][\w.:]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)\s*(\/?)>/g;
const ATTR_RE = /([\w:.]+)\s*=\s*"([^"]*)"/g;

/** Strip XML comments, preserving newlines so line numbers stay correct. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Parse the file into a tag tree; returns the root element (or null). */
export function parseXaml(sourceText: string): { root: XamlTag | null; flat: XamlTag[] } {
  const text = stripComments(sourceText);
  const flat: XamlTag[] = [];
  const stack: XamlTag[] = [];
  let root: XamlTag | null = null;

  for (const m of text.matchAll(TAG_TOKEN_RE)) {
    const closing = m[1] === "/";
    const rawName = m[2]!;
    if (closing) {
      // Pop to the matching open tag (defensive against malformed nesting).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.raw === rawName) { stack.length = i; break; }
      }
      continue;
    }
    if (rawName.startsWith("?") || rawName.startsWith("!")) continue;

    const line = text.slice(0, m.index).split("\n").length;
    const colon = rawName.indexOf(":");
    const local = colon === -1 ? rawName : rawName.slice(colon + 1);
    const tag: XamlTag = {
      name: local.includes(".") ? local : local,
      prefix: colon === -1 ? "" : rawName.slice(0, colon),
      raw: rawName,
      attrs: {},
      line,
      children: [],
      isProperty: local.includes("."),
    };
    for (const am of m[3]!.matchAll(ATTR_RE)) tag.attrs[am[1]!] = am[2]!;

    // Attach to the nearest non-property ancestor so DataTemplate content stays
    // in the tree while `<StackPanel.Background>` wrappers stay invisible.
    if (!tag.isProperty) {
      let parent: XamlTag | undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (!stack[i]!.isProperty) { parent = stack[i]; break; }
      }
      if (parent) parent.children.push(tag);
      else if (!root) root = tag;
      flat.push(tag);
    }

    const selfClosing = m[4] === "/";
    if (!selfClosing) stack.push(tag);
  }
  return { root, flat };
}

// ─── Interactive elements ──────────────────────────────────────────────────

/** Event attributes whose value is a code-behind method name (WPF/Avalonia
 *  `Click`, MAUI/Xamarin `Clicked`/`ItemTapped`). */
const EVENT_ATTRS = new Set([
  "Click", "DoubleTapped", "Tapped", "PointerPressed", "PointerReleased",
  "PointerWheelChanged", "KeyDown", "KeyUp", "TextChanged", "TextChanging",
  "SelectionChanged", "Checked", "Unchecked", "Toggled", "ValueChanged",
  "Closing", "Opened", "DragOver", "Drop", "LostFocus", "GotFocus",
  "MouseDown", "MouseUp", "MouseDoubleClick", "MouseLeftButtonDown",
  "MouseLeftButtonUp", "TouchDown", "Scroll", "ScrollChanged",
  "Clicked", "ItemSelected", "ItemTapped", "Refreshing", "SearchButtonPressed",
]);

const ELEMENT_BY_TAG: Array<[RegExp, InteractiveElementInfo["element"]]> = [
  [/Button$|MenuItem$|CheckBox$|RadioButton$|Hyperlink/, "button"],
  [/ComboBox$|ListBox$|ListView$/, "select"],
  [/TextBox$|NumericUpDown$|Slider$|DatePicker$|TimePicker$|AutoCompleteBox$/, "input"],
];

function elementOf(tag: string): InteractiveElementInfo["element"] {
  for (const [re, el] of ELEMENT_BY_TAG) if (re.test(tag)) return el;
  return "custom";
}

const COMMAND_BINDING_RE = /^\{\s*(?:CompiledBinding|Binding|x:Bind)\s+([A-Za-z_][\w.]*)/;

export function extractXamlInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const { flat } = parseXaml(lines.join("\n"));
  const out: InteractiveElementInfo[] = [];
  for (const tag of flat) {
    for (const [attr, value] of Object.entries(tag.attrs)) {
      if (EVENT_ATTRS.has(attr) && /^[A-Za-z_]\w*$/.test(value)) {
        out.push({
          element: elementOf(tag.name),
          event: attr,
          handler: value,
          line: tag.line,
          component: tag.name,
        });
      } else if (attr === "Command" || attr.endsWith(".Command")) {
        const b = value.match(COMMAND_BINDING_RE);
        if (b) {
          out.push({
            element: elementOf(tag.name),
            event: "command",
            handler: b[1]!.split(".").pop()!,
            line: tag.line,
            component: tag.name,
          });
        }
      }
    }
  }
  return out;
}

// ─── Screens ───────────────────────────────────────────────────────────────

const CATEGORY_BY_TAG: Array<[RegExp, ScreenComponentCategory]> = [
  [/Button$|CheckBox$|RadioButton$|MenuItem$|Hyperlink/, "action"],
  [/TextBox$|NumericUpDown$|Slider$|ComboBox$|DatePicker$|TimePicker$|AutoCompleteBox$|ToggleSwitch$/, "input"],
  [/TextBlock$|Label$|Image$|Icon$|ProgressBar$|PathIcon$/, "display"],
  [/ListBox$|ListView$|DataGrid$|TreeView$|ItemsControl$|ItemsRepeater$|Gallery/, "data"],
  [/Menu$|TabControl$|TabItem$|NavigationView$|ToolBar$|Toolbar/, "navigation"],
  [/Window$|UserControl$|Panel$|Grid$|Border$|StackPanel$|WrapPanel$|DockPanel$|Canvas$|ScrollViewer$|GroupBox$|Expander$|SplitView$|Control$/, "container"],
];

function categoryOf(tag: string): ScreenComponentCategory {
  for (const [re, cat] of CATEGORY_BY_TAG) if (re.test(tag)) return cat;
  return "custom";
}

/** Non-visual resource/style machinery — excluded from the component tree. */
const NON_UI_TAG_RE =
  /(Brush$|Style$|Styles$|Setter$|ResourceDictionary$|ControlTheme$|Transition(s)?$|Animation$|KeyFrame$|Converter$|GradientStop$|BitmapImage$|Geometry$|Transform(Group)?$|Definition(s)?$)/;

function toScreenComponent(tag: XamlTag): ScreenComponentInfo | null {
  if (NON_UI_TAG_RE.test(tag.name)) return null;
  const events = Object.keys(tag.attrs).filter((a) => EVENT_ATTRS.has(a));
  return {
    name: tag.attrs["x:Name"] ?? tag.attrs["Name"] ?? tag.name,
    componentType: tag.name,
    category: categoryOf(tag.name),
    caption: tag.attrs["Title"] ?? tag.attrs["Header"] ?? tag.attrs["Content"] ?? null,
    position: null,
    align: null,
    visible: true,
    children: tag.children.map(toScreenComponent).filter((c): c is ScreenComponentInfo => c !== null),
    events,
    dataBindings: [],
    line: tag.line,
  };
}

export function extractXamlScreens(lines: string[], filePath: string): ScreenInfo[] {
  const { root } = parseXaml(lines.join("\n"));
  if (!root) return [];
  // Resource-only files (styles, icon dictionaries) aren't screens.
  if (/^(ResourceDictionary|Styles|Application)$/.test(root.name)) return [];
  const base = filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.(axaml|xaml)$/i, "");
  const xClass = root.attrs["x:Class"];
  const width = Number(root.attrs["Width"] ?? root.attrs["d:DesignWidth"]);
  const height = Number(root.attrs["Height"] ?? root.attrs["d:DesignHeight"]);
  return [
    {
      name: xClass ? xClass.split(".").pop()! : base,
      formType: root.name,
      caption: root.attrs["Title"] ?? null,
      dimensions: width > 0 && height > 0 ? { width, height } : null,
      components: root.children.map(toScreenComponent).filter((c): c is ScreenComponentInfo => c !== null),
      filePath,
      routePath: null,
      // A MAUI Shell offers the pages its tabs and flyout items hold.
      navigatesTo: root.name === "Shell" ? extractShellRoutes(lines).map((r) => r.path) : [],
      ...(root.attrs["x:DataType"] ? { viewModel: root.attrs["x:DataType"].replace(/^\{x:Type\s+|\}$/g, "").split(":").pop()!.split(".").pop()! } : {}),
    },
  ];
}

// ─── Sub-components ────────────────────────────────────────────────────────

/** xmlns-prefixed tags are project/library components (`ui:PhMenuItem`);
 *  the xml-infra prefixes (x, d, mc) never name components. */
const INFRA_PREFIXES = new Set(["x", "d", "mc", "xmlns"]);

export function extractXamlSubComponents(lines: string[]): SubComponentInfo[] {
  const { flat } = parseXaml(lines.join("\n"));
  const out: SubComponentInfo[] = [];
  const seen = new Set<string>();
  for (const tag of flat) {
    if (!tag.prefix || INFRA_PREFIXES.has(tag.prefix)) continue;
    if (!/^[A-Z]/.test(tag.name)) continue;
    const key = `${tag.name}:${tag.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: tag.name, importSource: null, props: Object.keys(tag.attrs), line: tag.line });
  }
  return out;
}

/**
 * A MAUI `<Shell>`'s routes: each `<ShellContent Route="Catalog" ContentTemplate="{DataTemplate
 * views:CatalogView}">` is a page at its route under the routes of the `<TabBar>`, `<FlyoutItem>`
 * or `<Tab>` holding it — `/Main/Catalog`, what `GoToAsync("//Main/Catalog")` opens. The view
 * class is the route's component; core finds the screen of that name.
 */
export function extractShellRoutes(lines: string[]): RouteInfo[] {
  const { root } = parseXaml(lines.join("\n"));
  if (!root || root.name !== "Shell") return [];
  const routes: RouteInfo[] = [];
  const walk = (tag: XamlTag, above: string[]): void => {
    const own = tag.attrs["Route"];
    const path = own && !tag.isProperty ? [...above, own] : above;
    if (tag.name === "ShellContent" && own) {
      const view = /\{DataTemplate\s+(?:[\w]+:)?([\w.]+)\s*\}/.exec(tag.attrs["ContentTemplate"] ?? "")?.[1]?.split(".").pop() ?? null;
      if (view) routes.push({ path: "/" + path.join("/"), httpMethod: null, kind: "frontend", handler: view, componentPath: view, calls: [], middleware: [], line: tag.line });
    }
    for (const child of tag.children) walk(child, path);
  };
  walk(root, []);
  return routes;
}

export const xamlSpec: RegexLangSpec = {
  language: "xaml",
  extensions: [".xaml", ".axaml"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],

  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],

  extractScreens: (lines, filePath) => extractXamlScreens(lines, filePath),
  extractRoutes: (lines) => extractShellRoutes(lines),
  extractInteractiveElements: extractXamlInteractiveElements,
  extractSubComponents: extractXamlSubComponents,
};
