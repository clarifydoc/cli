import type { RouteInfo } from "../../../types/analysis.js";

/**
 * SwiftUI navigation: the views a view opens, as frontend routes named by
 * the destination view and flagged `navigation` (the declaring view's screen
 * opens them).
 *
 *   WindowGroup { ContentView() }                                  → ContentView (the app's root)
 *   NavigationLink("Edit", destination: EditView(item: item))      → EditView
 *   NavigationLink { DetailView(item: item) } label: { … }         → DetailView
 *   .navigationDestination(for: Item.self) { item in ItemView(item: item) } → ItemView
 *   .sheet(isPresented: $adding) { AddItemView() }                  → AddItemView
 *   TabView { HomeView().tabItem { … }; SettingsView().tabItem { … } } → HomeView, SettingsView
 *
 * A destination is the first view constructed (a PascalCase call) in the
 * `destination:` argument or the trailing closure. The screen builder
 * resolves the view by name — Swift files share their module's types.
 */

const OPENERS = /\b(NavigationLink|WindowGroup|DocumentGroup)\b|\.(navigationDestination|sheet|fullScreenCover|popover)\s*\(/g;
const NOT_VIEWS = new Set(["Text", "Label", "Image", "Button", "HStack", "VStack", "ZStack", "List", "ForEach", "Group", "Section", "Spacer", "Color", "Divider", "NavigationStack", "NavigationView", "ScrollView", "Form", "EmptyView", "AnyView", "Binding", "LazyVStack", "LazyHStack", "GeometryReader", "Toggle", "TextField", "Picker", "ProgressView"]);

/** The text from `open` to its matching close bracket (exclusive), or null. */
function balanced(text: string, open: number): string | null {
  const pairs: Record<string, string> = { "(": ")", "{": "}" };
  const close = pairs[text[open]!];
  if (!close) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return null;
      i = end;
    } else if (c === text[open]) depth++;
    else if (c === close && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** The first view a piece of SwiftUI constructs: `DetailView(item: x)` → DetailView. */
function firstView(code: string): string | null {
  for (const m of code.matchAll(/(?<![\w.])([A-Z]\w*)\s*\(/g)) {
    if (!NOT_VIEWS.has(m[1]!)) return m[1]!;
  }
  return null;
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

export function extractSwiftUINavigation(lines: string[]): RouteInfo[] {
  const text = lines.join("\n").replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  if (!/\bimport\s+SwiftUI\b/.test(text)) return [];
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  const push = (view: string | null, offset: number) => {
    if (!view || seen.has(view)) return;
    seen.add(view);
    out.push({ path: view, httpMethod: null, kind: "frontend", handler: view, componentPath: view, calls: [], middleware: [], line: lineAt(text, offset), navigation: true });
  };
  for (const m of text.matchAll(OPENERS)) {
    // `.sheet(` matched its own paren: start there.
    let at = m.index! + m[0].length - (m[0].endsWith("(") ? 1 : 0);
    // `NavigationLink(…)` / `.sheet(…)`: the arguments, then any trailing closure.
    while (at < text.length && /\s/.test(text[at]!)) at++;
    let args = "";
    if (text[at] === "(") {
      args = balanced(text, at) ?? "";
      at += args.length + 2;
      while (at < text.length && /\s/.test(text[at]!)) at++;
    }
    // `NavigationLink(value: item) { label }`: the destination is the matching `.navigationDestination`.
    if (m[1] === "NavigationLink" && /\bvalue:/.test(args)) continue;
    const dest = /\bdestination:\s*/.exec(args);
    if (dest) {
      push(firstView(args.slice(dest.index + dest[0].length)), m.index!);
      continue;
    }
    const closure = text[at] === "{" ? balanced(text, at) : null;
    if (closure === null) continue;
    // `{ item in ItemView(item: item) }`: skip the closure's parameters.
    const body = closure.replace(/^\s*[\w\s,()]*\bin\b/, "");
    push(firstView(body), m.index!);
  }
  // TabView's children are its tabs.
  for (const m of text.matchAll(/\bTabView\s*(?:\([^)]*\))?\s*\{/g)) {
    const body = balanced(text, m.index! + m[0].length - 1) ?? "";
    for (const v of body.matchAll(/(?<![\w.])([A-Z]\w*)\s*\([^)]*\)\s*\.tabItem\b/g)) push(v[1]!, m.index!);
  }
  return out;
}
