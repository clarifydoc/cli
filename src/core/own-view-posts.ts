import type { DataSourceInfo, FileAnalysis, ScreenInfo } from "../types/analysis.js";
import { handlerOf, materializeElementRequests } from "../extractors/plugins/shared/element-requests.js";

/**
 * A server-rendered `<form method="post">` with no `action` posts to the URL its page was served from.
 * The reader marks the form and its submit controls (`InteractiveElementInfo.ownViewPost`) because a
 * template cannot know its URL; the route that renders the screen (`ScreenInfo.renderedBy`) does. When
 * every route rendering the screen is at ONE path, the controls request a POST at it — as a form with
 * that `action` written out would — and the rows are returned for the route linker. A screen served at
 * several paths (a template shared by two routes) says nothing: the browser posts to whichever URL it
 * was opened at.
 *
 * Returns the api-call rows added, each with its file.
 */
export function linkOwnViewPosts(
  screens: readonly ScreenInfo[],
  analyses: readonly FileAnalysis[],
): Array<DataSourceInfo & { filePath: string }> {
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const out: Array<DataSourceInfo & { filePath: string }> = [];
  for (const screen of screens) {
    const paths = new Set((screen.renderedBy ?? []).map((r) => r.path));
    if (paths.size !== 1) continue;
    const a = byPath.get(screen.filePath);
    if (!a) continue;
    const path = [...paths][0]!;
    const touched = new Set<unknown>();
    for (const el of a.interactiveElements) {
      if (!el.ownViewPost || el.request) continue;
      el.request = { method: "POST", target: path };
      el.handler = handlerOf("POST", path);
      touched.add(el);
    }
    if (touched.size === 0) continue;
    for (const row of materializeElementRequests(a, touched)) out.push({ ...row, filePath: a.filePath });
  }
  return out;
}
