import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";

/**
 * A hand-rolled client router: a table of `{ path: '/home', screen: 'Home' }`
 * entries (no component of its own) and a layout that shows each screen by
 * that key — `<HomeScreen v-show="screen === 'Home'" />`. Neither file alone
 * says which page a path opens; joined by the key, every entry is a frontend
 * route to the component the layout shows for it.
 */
export const SCREEN_TABLE_FACT = "screen-table";
export const SCREEN_SWITCH_FACT = "screen-switch";

/** The property naming the screen an entry opens. */
const SCREEN_KEYS = new Set(["screen", "view", "page"]);

export interface ScreenTableFact {
  key: string;
  items: Array<{ path: string; value: string; line: number }>;
}

export interface ScreenSwitchFact {
  /** The variable compared (`screen`). */
  key: string;
  value: string;
  /** The component shown, as the template names it. */
  tag: string;
  /** Where its import comes from, when the file imports it. */
  importSource: string | null;
  /** Else the line binding the name to a lazily loaded module (`const X = defineAsyncComponent(() => import(…))`). */
  bindLine?: number;
}

const stringValue = (n: Node | null): string | null =>
  n && n.type === "string" ? n.text.slice(1, -1) : n && n.type === "template_string" && !n.text.includes("${") ? n.text.slice(1, -1) : null;

/** `const routes = [{ path: '/home', screen: 'Home' }, …]` at the top level: the table, when two entries or more name a screen. */
export function collectScreenTables(root: Node, sourceText: string, facts: RouteFact[]): void {
  if (!/\b(?:screen|view|page)\s*:/.test(sourceText) || !/\bpath\s*:/.test(sourceText)) return;
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.namedChildren.find((c) => c.type === "lexical_declaration") : stmt;
    if (decl?.type !== "lexical_declaration") continue;
    for (const d of decl.namedChildren) {
      let value = d.type === "variable_declarator" ? d.childForFieldName("value") : null;
      while (value && (value.type === "as_expression" || value.type === "satisfies_expression" || value.type === "parenthesized_expression")) value = value.namedChildren[0] ?? null;
      if (value?.type !== "array") continue;
      const byKey = new Map<string, ScreenTableFact["items"]>();
      for (const el of value.namedChildren) {
        if (el.type !== "object") continue;
        let path: string | null = null;
        const screens: Array<[string, string]> = [];
        let component = false;
        for (const pair of el.namedChildren) {
          if (pair.type !== "pair") continue;
          const key = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
          const v = pair.childForFieldName("value");
          if (!key || !v) continue;
          if (key === "path") path = stringValue(v);
          else if (key === "component" || key === "element") component = true;
          else if (SCREEN_KEYS.has(key)) {
            const s = stringValue(v);
            if (s) screens.push([key, s]);
          }
        }
        if (path === null || !path.startsWith("/") || component) continue;
        for (const [key, s] of screens) (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ path, value: s, line: el.startPosition.row + 1 });
      }
      for (const [key, items] of byKey) {
        if (items.length >= 2) facts.push({ kind: SCREEN_TABLE_FACT, line: d.startPosition.row + 1, data: { key, items } satisfies ScreenTableFact });
      }
    }
  }
}

const SWITCH_ATTR = /\bv-(?:if|show|else-if)\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*===?\s*'([^'"]+)'\s*"/;

/**
 * `<HomeScreen v-show="screen === 'Home'" />` in a Vue template: the component
 * shown when the variable holds that key. One fact per element whose own
 * condition is exactly that comparison.
 */
export function screenSwitchFacts(template: string, templateOffsetLine: number, imports: FileAnalysis["imports"], source = ""): RouteFact[] {
  if (!template.includes("===") && !template.includes("==")) return [];
  const out: RouteFact[] = [];
  const lines = template.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(/<([A-Z][\w]*|[a-z][\w]*(?:-[\w]+)+)\b([^<>]*)>/g)) {
      const cond = SWITCH_ATTR.exec(m[2]!);
      if (!cond) continue;
      const tag = m[1]!.includes("-") ? m[1]!.replace(/(^|-)([a-z])/g, (_x, _d, c: string) => c.toUpperCase()) : m[1]!;
      const importSource = imports.find((imp) => imp.specifiers.includes(tag))?.source ?? null;
      const bindLine = importSource ? null : lazyBindLine(tag, source);
      out.push({ kind: SCREEN_SWITCH_FACT, line: templateOffsetLine + i, data: { key: cond[1]!, value: cond[2]!, tag, importSource, ...(bindLine ? { bindLine } : {}) } satisfies ScreenSwitchFact });
    }
  }
  return out;
}

/** `const HomeScreen = defineAsyncComponent(() => import('./HomeScreen.vue'))`: the line binding the name, when it loads a module there. */
function lazyBindLine(tag: string, source: string): number | null {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${tag}\\s*=([^;]{0,200})`).exec(source);
  if (!m || !/\bimport\s*\(/.test(m[1]!)) return null;
  return source.slice(0, m.index).split("\n").length;
}

/** Joins each screen-table entry to the one component a layout shows for its key. */
export const screenTableResolver: RouteResolver = {
  id: "screen-table",
  languages: ["typescript", "javascript"],
  priority: 55,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const tables = analyses.filter((a) => a.routeFacts?.some((f) => f.kind === SCREEN_TABLE_FACT));
    if (tables.length === 0) return;
    const shown = new Map<string, Set<string>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== SCREEN_SWITCH_FACT) continue;
        const s = f.data as ScreenSwitchFact;
        // A lazily bound name: the one dynamic import on (or just below) its binding line.
        // A lazily bound name: the dynamic import on its binding line, else the first below it (the call wrapped).
        const near = s.importSource || s.bindLine === undefined ? [] : a.imports.filter((imp) => imp.dynamic && imp.line >= s.bindLine! && imp.line <= s.bindLine! + 2);
        const lazy = near.find((imp) => imp.line === s.bindLine) ?? near.filter((imp) => imp.line === s.bindLine! + 1)[0];
        const spec = s.importSource ?? lazy?.source ?? null;
        if (!spec) continue;
        const file = ctx.resolveModule(a.filePath, spec);
        if (!file) continue;
        const k = `${a.projectId ?? ""}\u0000${s.key}\u0000${s.value}`;
        (shown.get(k) ?? shown.set(k, new Set()).get(k)!).add(file);
      }
    }
    if (shown.size === 0) return;
    for (const a of tables) {
      const added: RouteInfo[] = [];
      for (const f of a.routeFacts!) {
        if (f.kind !== SCREEN_TABLE_FACT) continue;
        const t = f.data as ScreenTableFact;
        for (const item of t.items) {
          const files = shown.get(`${a.projectId ?? ""}\u0000${t.key}\u0000${item.value}`);
          // One component per key, or the key says nothing.
          if (!files || files.size !== 1) continue;
          const file = [...files][0]!;
          if (a.routes.some((r) => r.kind === "frontend" && r.path === item.path)) continue;
          added.push({
            path: item.path,
            httpMethod: null,
            kind: "frontend",
            handler: file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
            componentPath: file,
            calls: [],
            middleware: [],
            line: item.line,
          });
        }
      }
      if (added.length > 0) a.routes = [...a.routes, ...added];
    }
  },
};
