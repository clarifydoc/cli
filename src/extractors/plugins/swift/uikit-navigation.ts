import type { RouteInfo } from "../../../types/analysis.js";
import { NAV_BY_SEGUE, NAV_BY_STORYBOARD_ID } from "../shared/storyboard.js";

/**
 * UIKit navigation by class: the view controllers a file opens.
 *
 *   navigationController?.pushViewController(OrderViewController(), animated: true) → OrderViewController
 *   present(SettingsViewController(), animated: true)                              → SettingsViewController
 *   storyboard.instantiateViewController(withIdentifier: "Cart") as? CartViewController → CartViewController
 *   storyboard?.instantiateViewController(withIdentifier: "Cart")             → @storyboard/Cart
 *   performSegue(withIdentifier: "showCart", sender: self)                    → @segue/showCart
 *
 * Rows are frontend routes named by the class and flagged `navigation`; the
 * screen-class pass makes the class itself a screen. A row by storyboard id
 * or segue waits for the storyboards: the storyboard resolver
 * (`storyboard-navigation.ts`) names the class, or drops the row.
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
  for (const m of text.matchAll(/instantiateViewController\s*\(\s*withIdentifier:\s*"([^"]+)"\s*\)(?!\s*as\b)/g)) push(`${NAV_BY_STORYBOARD_ID}${m[1]}`, m.index!);
  for (const m of text.matchAll(/\bperformSegue\s*\(\s*withIdentifier:\s*"([^"]+)"/g)) push(`${NAV_BY_SEGUE}${m[1]}`, m.index!);
  return out;
}
