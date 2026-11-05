/**
 * Browser tests drive the app by address: `page.goto("/clubs/1/squad")` opens the
 * page the client router serves there. Each navigation the plugins read in test
 * code (`FileAnalysis.browserNavigations`) is joined to the screens at that path
 * the way the navigation map joins an app's own links (`screenPathMatcher`) —
 * every screen at it (a nested route's layout and its index page both render),
 * those of the test's own sub-project first, else those of any ONE sub-project:
 * a browser suite is often a package of its own, reaching the app by URL, not by
 * import, and two apps serving the path name neither.
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
      const screens = [...new Set(match.screensAtPath(n.path, a.projectId).map((s) => s.filePath))].sort(byOrdinal);
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
