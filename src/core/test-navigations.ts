/**
 * Browser tests drive the app by address: `page.goto("/clubs/1/squad")` opens the
 * page the client router serves there. Each navigation the plugins read in test
 * code (`FileAnalysis.browserNavigations`) is joined to the screens at that path
 * the way the navigation map joins an app's own links (`screenPathMatcher`) —
 * every screen at it (a nested route's layout and its index page both render),
 * those of the test's own sub-project first, else those of any ONE sub-project:
 * a browser suite is often a package of its own, reaching the app by URL, not by
 * import, and two apps serving the path name neither (nor does `/` from another sub-project:
 * every app has a home, often served under a base the router does not state).
 */

import type { FileAnalysis, ScreenInfo, TestNavigationRow } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { screenPathMatcher } from "./screen-flow.js";

export function joinTestNavigations(input: {
  analyses: ReadonlyArray<Pick<FileAnalysis, "filePath" | "projectId" | "functions" | "classes" | "browserNavigations">>;
  screens: readonly ScreenInfo[];
  projectOf: (file: string) => string | undefined;
  /** Whether a file is test code. */
  isTest: (file: string) => boolean;
}): TestNavigationRow[] {
  const { analyses, screens, projectOf, isTest } = input;
  const out: TestNavigationRow[] = [];
  let match: ReturnType<typeof screenPathMatcher> | undefined;
  for (const a of analyses) {
    if (!a.browserNavigations?.length || !isTest(a.filePath)) continue;
    match ??= screenPathMatcher(screens, projectOf);
    const enclosing = functionsByLine(a);
    for (const n of a.browserNavigations) {
      const hits = match.screensAtPath(n.path, a.projectId);
      // Every app has a home: `/` reached across sub-projects names no one app's.
      const screens = hits.length && (n.path !== "/" || projectOf(hits[0]!.filePath) === a.projectId)
        ? [...new Set(hits.map((s) => s.filePath))].sort(byOrdinal)
        : [];
      const symbol = enclosing(n.line);
      out.push({ file: a.filePath, line: n.line, ...(symbol ? { symbol } : {}), path: n.path, ...(screens.length ? { screens } : {}) });
    }
  }
  return out.sort((x, y) => byOrdinal(x.file, y.file) || x.line - y.line);
}

/** The innermost function or method spanning a line, by its symbol (`Class.method` for a method). */
function functionsByLine(a: Pick<FileAnalysis, "functions" | "classes">): (line: number) => string | undefined {
  const spans = [
    ...a.functions.filter((f) => f.name !== "<setup>").map((f) => ({ symbol: f.name, line: f.line, end: f.endLine })),
    ...a.classes.flatMap((c) => c.methods.map((m) => ({ symbol: `${c.name}.${m.name}`, line: m.line, end: m.endLine }))),
  ];
  return (line) => {
    let best: (typeof spans)[number] | undefined;
    for (const s of spans) if (s.line <= line && line <= s.end && (!best || s.end - s.line < best.end - best.line)) best = s;
    return best?.symbol;
  };
}

/** Past this many UI files using it, a component is shared: it is part of every page using it, what it uses is no part of theirs through it. */
export const SHARED_COMPONENT_USERS = 20;
/** How many uses below the page (or the app's start) its parts are followed. */
const PART_DEPTH = 6;

/**
 * What runs when a browser test opens a page: the page is the sum of what makes it up. For each
 * screen a navigation opens, and for the file starting its app (`FileAnalysis.appMount` — the one
 * of the screen's sub-project whose imports reach the screen; a test opening any page runs it and
 * the root component it mounts), the files it uses, `PART_DEPTH` uses deep over the screen map's
 * uses graph (what a UI file's markup renders and the modules it imports; a module's imports):
 * - never into another page (a screen with a route of its own), never on past the route table;
 * - a module that is no component (a composable, a store, a helper) is a part, a way on only to
 *   the component it loads on demand (`defineAsyncComponent(() => import("./Editor.vue"))`): a
 *   store's own imports are code depending on code, and the components a registration module
 *   lists (`app.component("DatePicker", …)` for every page) are none this page shows;
 * - never on below a shared component (more than `SHARED_COMPONENT_USERS` UI files use it): the
 *   component is part of the page, what lies below it is not credited through it.
 * Each row of a joined navigation gets its `entry`; the parts are keyed by screen and entry file.
 */
export function pagePartsOf(input: {
  rows: TestNavigationRow[];
  /** File → what it uses (the screen map's uses graph). */
  uses: Record<string, string[]>;
  /** File → what it imports, dynamic imports included: whether a start file reaches a page. */
  imports: Record<string, string[]>;
  /** File → what it imports on demand only (`import("./x")`). */
  lazy: Record<string, string[]>;
  screens: readonly ScreenInfo[];
  /** Files declaring the client router's routes. */
  routeFiles: ReadonlySet<string>;
  /** Files starting a browser app (`FileAnalysis.appMount`). */
  mounts: readonly string[];
  projectOf: (file: string) => string | undefined;
  isTest: (file: string) => boolean;
}): Record<string, string[]> {
  const { rows, uses, imports, lazy, screens, routeFiles, mounts, projectOf, isTest } = input;
  const ui = new Set(screens.map((s) => s.filePath));
  const pages = new Set(screens.filter((s) => s.routePath || s.otherRoutes?.length || s.renderedBy?.length).map((s) => s.filePath));
  const users = new Map<string, number>();
  for (const [from, deps] of Object.entries(uses)) {
    if (!ui.has(from) || isTest(from)) continue;
    for (const d of new Set(deps)) if (d !== from) users.set(d, (users.get(d) ?? 0) + 1);
  }
  const shared = (f: string) => (users.get(f) ?? 0) > SHARED_COMPONENT_USERS;

  // A start file's import closure, once each.
  const closures = new Map<string, Set<string>>();
  const closureOf = (start: string): Set<string> => {
    let seen = closures.get(start);
    if (seen) return seen;
    seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const d of imports[queue.pop()!] ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    closures.set(start, seen);
    return seen;
  };
  const entryOf = (opened: readonly string[]): string | undefined => {
    const project = projectOf(opened[0]!);
    const found = mounts.filter((m) => projectOf(m) === project && opened.some((s) => closureOf(m).has(s)));
    return found.length === 1 ? found[0] : undefined;
  };

  const partsOf = (start: string): string[] => {
    const parts = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < PART_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        // A module that is no component leads on only to a component it loads on demand.
        const onward = ui.has(file) || file === start ? uses[file] ?? [] : (lazy[file] ?? []).filter((d) => ui.has(d));
        for (const d of onward) {
          if (parts.has(d) || pages.has(d) || isTest(d)) continue;
          parts.add(d);
          if (!routeFiles.has(d) && !shared(d)) next.push(d);
        }
      }
      frontier = next;
    }
    parts.delete(start);
    return [...parts].sort(byOrdinal);
  };

  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row.screens) continue;
    const entry = entryOf(row.screens);
    if (entry) row.entry = entry;
    for (const f of [...row.screens, ...(entry ? [entry] : [])]) out[f] ??= partsOf(f);
  }
  return out;
}
