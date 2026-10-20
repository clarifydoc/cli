import type { RouteFact } from "../../../types/analysis.js";

/**
 * An Interface Builder storyboard (`*.storyboard`): its scenes — each view
 * controller with the class it is (`customClass`) and the id code
 * instantiates it by (`storyboardIdentifier`) — and the segues inside each,
 * whether on the controller or on a button in it. The storyboard plugin
 * states this as one `routeFact`; the Swift plugin's resolver
 * (`swift/storyboard-navigation.ts`) joins it to the classes and to
 * `performSegue(withIdentifier:)`.
 *
 *   <viewController storyboardIdentifier="Detail" id="BYZ-38" customClass="DetailViewController" sceneMemberID="viewController">
 *     <connections><segue destination="Q3k-9a" kind="show" identifier="showNote" id="…"/></connections>
 *   </viewController>
 */

export const IOS_STORYBOARD = "ios-storyboard";

/** A navigation row naming a storyboard id rather than a class, until the resolver reads the storyboards. */
export const NAV_BY_SEGUE = "@segue/";
export const NAV_BY_STORYBOARD_ID = "@storyboard/";

export interface StoryboardFact {
  scenes: Array<{
    /** The controller element's id, which segues name as `destination`. */
    id: string;
    cls: string | null;
    storyboardId: string | null;
    line: number;
    segues: Array<{ to: string; identifier: string | null; kind: string | null; relationship: string | null }>;
  }>;
}

const TAG_RE = /<(\/?)([a-zA-Z][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

export function storyboardFacts(lines: string[], facts: RouteFact[]): void {
  const text = lines.join("\n");
  if (!/<document\b[^>]*\btype="com\.apple\.InterfaceBuilder/.test(text)) return;
  const fact: StoryboardFact = { scenes: [] };
  const stack: Array<{ tag: string; scene?: StoryboardFact["scenes"][number] }> = [];
  let line = 1;
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    for (let i = last; i < m.index!; i++) if (text[i] === "\n") line++;
    last = m.index!;
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      while (stack.length && stack.pop()!.tag !== tag);
      continue;
    }
    const attrs = new Map([...rawAttrs!.matchAll(ATTR_RE)].map((a) => [a[1]!, a[2]!]));
    const entry: (typeof stack)[number] = { tag: tag! };
    if (attrs.get("sceneMemberID") === "viewController" && attrs.get("id")) {
      entry.scene = { id: attrs.get("id")!, cls: attrs.get("customClass") ?? null, storyboardId: attrs.get("storyboardIdentifier") ?? null, line, segues: [] };
      fact.scenes.push(entry.scene);
    } else if (tag === "segue" && attrs.get("destination")) {
      const holder = [...stack].reverse().find((s) => s.scene)?.scene;
      holder?.segues.push({ to: attrs.get("destination")!, identifier: attrs.get("identifier") ?? null, kind: attrs.get("kind") ?? null, relationship: attrs.get("relationship") ?? null });
    }
    if (!selfClosing) stack.push(entry);
  }
  if (fact.scenes.length) facts.push({ kind: IOS_STORYBOARD, line: 1, data: fact });
}
