import type { InteractiveElementInfo, ScreenComponentInfo, SubComponentInfo } from "../../../types/analysis.js";

/**
 * HEEx / EEx markup — Phoenix templates (`.html.heex`) and LiveView `~H"""`
 * sigils in `.ex` files read by one scanner:
 *   - `phx-click|submit|change|blur|focus|keyup|keydown="event"` (or
 *     `{JS.push("event")}`) → an interactive element whose handler is the
 *     event name; `PhoenixEventResolver` joins it to the LiveView's
 *     `handle_event("event")` clause;
 *   - `<.link navigate|patch|href={~p"/x/#{y}"}>`, `<a href="/x">`, and
 *     `<.form|form action=…>` → an element carrying `request` (`method="delete"`
 *     honoured; forms POST by default), interpolations as `:param` segments;
 *   - `<.live_component module={Mod}>` and remote components `<Mod.fun>` →
 *     sub-components; local function components `<.card>` too, minus
 *     Phoenix's own (`.link`, `.form`, `.input`, …).
 */

const PHOENIX_BUILTIN_COMPONENTS = new Set([
  "link", "form", "input", "inputs_for", "live_component", "live_file_input", "live_img_preview", "live_title",
  "focus_wrap", "dynamic_tag", "intersperse", "async_result", "error", "label", "button", "flash", "header", "icon",
]);

const TAG_RE = /<(\.?[A-Za-z][\w.:-]*)((?:\s|"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|[^>"'{\s])*?)\/?>/g;
const PHX_EVENT_RE = /\bphx-(click|submit|change|blur|focus|keyup|keydown|window-keyup|window-keydown|click-away)\s*=\s*/g;

/**
 * The event a `phx-*` value pushes: `"save"`, `{"save"}`, `{JS.push("save")}`, or a
 * command chain over lines whose push comes after other commands
 * (`{JS.hide(to: "#x", transition: {…}) |> JS.push("pin")}`).
 */
function pushedEvent(attrs: string, at: number): string | null {
  if (attrs[at] === '"') return /^"([^"]+)"/.exec(attrs.slice(at))?.[1] ?? null;
  if (attrs[at] !== "{") return null;
  let depth = 0;
  let end = at;
  for (let i = at; i < attrs.length; i++) {
    const ch = attrs[i];
    if (ch === '"') {
      // A string, its `#{…}` interpolations included.
      for (i++; i < attrs.length && attrs[i] !== '"'; i++) if (attrs[i] === "\\") i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { end = i; break; }
  }
  const value = attrs.slice(at + 1, end);
  return /JS\.push\(\s*"([^"]+)"/.exec(value)?.[1] ?? /^\s*"([^"]+)"/.exec(value)?.[1] ?? null;
}

export interface HeexRead {
  elements: InteractiveElementInfo[];
  subComponents: SubComponentInfo[];
  components: ScreenComponentInfo[];
  caption: string | null;
}

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** `{~p"/sites/#{@site.domain}/settings"}`, `"/x"`, `{"/#{x}/settings"}` → `/sites/:param/settings`; null when not an app path. */
function pathOf(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^\{?\s*(?:~p)?"([^"]*)"\s*\}?$/.exec(value.trim()) ?? /^'([^']*)'$/.exec(value.trim());
  if (!m) return null;
  const path = m[1]!.replace(/#\{[^}]*\}/g, ":param").replace(/[?#].*$/, "");
  return path.startsWith("/") ? path : null;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|\\{(?:[^{}]|\\{[^{}]*\\})*\\})`).exec(attrs);
  return m?.[1];
}

const elementKind = (tag: string): InteractiveElementInfo["element"] => {
  const t = tag.replace(/^\./, "").toLowerCase();
  if (t === "button") return "button";
  if (t === "a" || t === "link") return "link";
  if (t === "form") return "form";
  if (t === "input") return "input";
  if (t === "select") return "select";
  if (t === "textarea") return "textarea";
  return "custom";
};

/** Handler for a request: the path for a GET, `<verb>_<path>` otherwise (identifier-shaped). */
export function requestHandler(method: string, target: string): string {
  const base = target.replace(/^\//, "").replace(/:param/g, "x").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
  return method === "GET" ? base : `${method.toLowerCase()}_${base}`;
}

/** Read HEEx markup (`text`), reporting lines offset by `firstLine - 1`. */
export function readHeex(text: string, firstLine = 1): HeexRead {
  const elements: InteractiveElementInfo[] = [];
  const subComponents: SubComponentInfo[] = [];
  const components: ScreenComponentInfo[] = [];
  const offset = firstLine - 1;
  const component = (name: string, componentType: string, category: ScreenComponentInfo["category"], line: number, events: string[]): void => {
    components.push({ name, componentType, category, caption: null, position: null, align: null, visible: true, children: [], events, dataBindings: [], line });
  };
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const tag = m[1]!;
    const attrs = m[2] ?? "";
    const line = lineAt(text, m.index) + offset;
    const kind = elementKind(tag);
    let hadEvent = false;
    PHX_EVENT_RE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = PHX_EVENT_RE.exec(attrs)) !== null) {
      const handler = pushedEvent(attrs, e.index + e[0].length);
      if (!handler || !/^[\w-]+$/.test(handler)) continue;
      hadEvent = true;
      elements.push({ element: kind, event: `phx-${e[1]}`, handler, line, ...(kind === "custom" ? { component: tag.replace(/^\./, "") } : {}) });
      component(handler, tag, kind === "form" ? "container" : "action", line, [`phx-${e[1]}: ${handler}`]);
    }
    const lower = tag.toLowerCase();
    if (lower === "a" || lower === ".link") {
      const target = pathOf(attr(attrs, "navigate") ?? attr(attrs, "patch") ?? attr(attrs, "href"));
      if (target && !hadEvent) {
        const method = (/^["']?(\w+)/.exec(attr(attrs, "method") ?? "")?.[1] ?? "get").toUpperCase();
        const handler = requestHandler(method, target);
        elements.push({ element: "link", event: "click", handler, line, request: { method, target } });
        component(target, tag, "navigation", line, [`click: ${handler}`]);
      }
    } else if (lower === "form" || lower === ".form") {
      const target = pathOf(attr(attrs, "action"));
      if (target) {
        const method = (/^["']?(\w+)/.exec(attr(attrs, "method") ?? "")?.[1] ?? "post").toUpperCase();
        const handler = requestHandler(method, target);
        elements.push({ element: "form", event: "submit", handler, line, request: { method, target } });
        component(target, tag, "container", line, [`submit: ${handler}`]);
      }
    } else if (lower === ".live_component") {
      const mod = /^\{\s*([A-Z][\w.]*)\s*\}$/.exec(attr(attrs, "module") ?? "")?.[1];
      if (mod) { subComponents.push({ name: mod, importSource: null, props: [], line }); component(mod, "live_component", "container", line, []); }
    } else if (/^[A-Z][\w]*(?:\.[A-Z]\w*)*\.[a-z_]\w*$/.test(tag)) {
      subComponents.push({ name: tag, importSource: null, props: [], line });
      component(tag, "component", "container", line, []);
    } else if (tag.startsWith(".") && !PHOENIX_BUILTIN_COMPONENTS.has(tag.slice(1))) {
      subComponents.push({ name: tag.slice(1), importSource: null, props: [], line });
    }
  }
  const caption = /<(?:h1|\.header|\.title)\b[^>]*>\s*([^<{]+?)\s*</i.exec(text)?.[1] ?? null;
  return { elements, subComponents, components, caption };
}

/** `~H"""` … `"""` sigil bodies in an Elixir file, with the line each body starts on. */
export function heexSigils(lines: string[]): Array<{ text: string; firstLine: number; startLine: number }> {
  const out: Array<{ text: string; firstLine: number; startLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/~H"""\s*$/.test(lines[i]!)) continue;
    const start = i;
    let j = i + 1;
    while (j < lines.length && !/^\s*"""/.test(lines[j]!)) j++;
    out.push({ text: lines.slice(i + 1, j).join("\n"), firstLine: i + 2, startLine: start + 1 });
    i = j;
  }
  return out;
}
