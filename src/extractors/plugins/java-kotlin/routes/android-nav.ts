import type { RouteInfo } from "../../../../types/analysis.js";
import { NAV_BY_ACTION, NAV_BY_ID } from "../../shared/android-nav-graph.js";

/**
 * Android navigation by class: the screens a file opens.
 *
 *   startActivity(Intent(this, OrderActivity::class.java))                → OrderActivity
 *   new Intent(MainActivity.this, OrderActivity.class)                     → OrderActivity
 *   supportFragmentManager.beginTransaction().replace(R.id.c, CartFragment()) → CartFragment
 *   .add(R.id.c, CartFragment.newInstance(id))                            → CartFragment
 *
 *   findNavController().navigate(R.id.action_home_to_detail)               → @id/action_home_to_detail
 *   navigate(HomeFragmentDirections.actionHomeToDetail(id))               → @action/actionHomeToDetail
 *
 * Rows are frontend routes named by the class and flagged `navigation`; the
 * screen-class pass makes the class itself a screen. A row by nav-graph id
 * waits for the graph: the nav-graph resolver (`android-nav-graph.ts`) names
 * the class it reaches, or drops the row.
 */
export function extractAndroidNavigation(sourceText: string): RouteInfo[] {
  if (!/\bIntent\s*\(|beginTransaction\s*\(|\.navigate\s*\(/.test(sourceText)) return [];
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  const push = (cls: string, at: number) => {
    if (seen.has(cls)) return;
    seen.add(cls);
    out.push({ path: cls, httpMethod: null, kind: "frontend", handler: cls, componentPath: cls, calls: [], middleware: [], line: lineAt(at), navigation: true });
  };
  for (const m of sourceText.matchAll(/\bIntent\s*\([^)]*?,\s*([A-Z]\w*)(?:::class\.java|\.class)\s*\)/g)) push(m[1]!, m.index!);
  for (const m of sourceText.matchAll(/\.(?:replace|add)\s*\(\s*[\w.]+\s*,\s*([A-Z]\w*Fragment\w*)\s*(?:\.newInstance)?\s*\(/g)) push(m[1]!, m.index!);
  for (const m of sourceText.matchAll(/\.navigate\s*\(\s*R\.id\.(\w+)/g)) push(`${NAV_BY_ID}${m[1]}`, m.index!);
  for (const m of sourceText.matchAll(/\.navigate\s*\(\s*[A-Z]\w*Directions(?:\.Companion)?\.(\w+)\s*\(/g)) push(`${NAV_BY_ACTION}${m[1]}`, m.index!);
  return out;
}
