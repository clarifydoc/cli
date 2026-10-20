import type { RouteInfo } from "../../../types/analysis.js";

/**
 * UIKit navigation by class: the view controllers a file opens.
 *
 *   navigationController?.pushViewController(OrderViewController(), animated: true) → OrderViewController
 *   present(SettingsViewController(), animated: true)                              → SettingsViewController
 *   storyboard.instantiateViewController(withIdentifier: "Cart") as? CartViewController → CartViewController
 *
 * Rows are frontend routes named by the class and flagged `navigation`; the
 * screen-class pass makes the class itself a screen. (`performSegue(withIdentifier:)`
 * names a storyboard segue, not a class: not read.)
 */
export function extractUIKitNavigation(lines: string[]): RouteInfo[] {
  const text = lines.join("\n");
  if (!/\bimport\s+UIKit\b/.test(text)) return [];
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  const push = (cls: string, at: number) => {
    if (seen.has(cls)) return;
    seen.add(cls);
    out.push({ path: cls, httpMethod: null, kind: "frontend", handler: cls, componentPath: cls, calls: [], middleware: [], line: lineAt(at), navigation: true });
  };
  for (const m of text.matchAll(/\b(?:pushViewController|present|show|showDetailViewController)\s*\(\s*([A-Z]\w*)\s*\(/g)) push(m[1]!, m.index!);
  for (const m of text.matchAll(/instantiateViewController\s*\([^)]*\)\s*as[?!]?\s*([A-Z]\w*)/g)) push(m[1]!, m.index!);
  return out;
}
