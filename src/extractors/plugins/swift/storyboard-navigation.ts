import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { IOS_STORYBOARD, NAV_BY_SEGUE, NAV_BY_STORYBOARD_ID, type StoryboardFact } from "../shared/storyboard.js";

/**
 * Storyboards joined to the code. Each scene names its view controller class;
 * each segue in it is an edge from that class to the class its destination
 * is — through a navigation or tab bar controller to the controllers it shows
 * (its `relationship` segues), since a plain container has no class of its
 * own. The edge is a navigation row in the file declaring the class, at the
 * class. A row by segue identifier (`performSegue(withIdentifier:)`) or
 * storyboard id (`instantiateViewController(withIdentifier:)`) names the
 * class it reaches; an id no storyboard has, or two give different classes,
 * names nothing and the row goes.
 */

type Scene = StoryboardFact["scenes"][number];

export const storyboardNavigationResolver: RouteResolver = {
  id: "ios-storyboard-navigation",
  languages: ["swift", "storyboard"],
  priority: 42,
  resolve(analyses: FileAnalysis[]): void {
    const scenes = analyses.flatMap((a) => (a.routeFacts ?? []).filter((f) => f.kind === IOS_STORYBOARD).flatMap((f) => (f.data as StoryboardFact).scenes));
    const code = analyses.filter((a) => a.language === "swift");
    const byId = new Map(scenes.map((s) => [s.id, s]));

    /** The classes a scene shows: its own, or a container's through its relationship segues. */
    const classesOf = (scene: Scene | undefined, depth = 0): string[] => {
      if (!scene) return [];
      if (scene.cls) return [scene.cls];
      if (depth > 3) return [];
      return scene.segues.filter((g) => g.kind === "relationship").flatMap((g) => classesOf(byId.get(g.to), depth + 1));
    };
    const single = (map: Map<string, string | null>, key: string | null, values: string[]) => {
      if (!key || values.length !== 1) return;
      map.set(key, map.has(key) && map.get(key) !== values[0] ? null : values[0]!);
    };
    const bySegue = new Map<string, string | null>();
    const byStoryboardId = new Map<string, string | null>();
    for (const s of scenes) {
      single(byStoryboardId, s.storyboardId, classesOf(s));
      for (const g of s.segues) single(bySegue, g.identifier, classesOf(byId.get(g.to)));
    }

    const holders = new Map<string, { analysis: FileAnalysis; line: number } | null>();
    for (const a of code) {
      for (const c of a.classes) holders.set(c.name, holders.has(c.name) ? null : { analysis: a, line: c.line });
    }
    const row = (target: string, line: number): RouteInfo => ({ path: target, httpMethod: null, kind: "frontend", handler: target, componentPath: target, calls: [], middleware: [], line, navigation: true });

    for (const s of scenes) {
      const holder = s.cls ? holders.get(s.cls) : undefined;
      if (!holder) continue;
      for (const g of s.segues) {
        if (g.kind === "relationship") continue;
        for (const target of classesOf(byId.get(g.to))) {
          if (!holder.analysis.routes.some((r) => r.navigation && r.path === target && r.line === holder.line)) holder.analysis.routes.push(row(target, holder.line));
        }
      }
    }

    for (const a of code) {
      if (!a.routes.some((r) => r.navigation && (r.path.startsWith(NAV_BY_SEGUE) || r.path.startsWith(NAV_BY_STORYBOARD_ID)))) continue;
      const kept: RouteInfo[] = [];
      for (const r of a.routes) {
        const segue = r.navigation && r.path.startsWith(NAV_BY_SEGUE) ? r.path.slice(NAV_BY_SEGUE.length) : null;
        const sbId = r.navigation && r.path.startsWith(NAV_BY_STORYBOARD_ID) ? r.path.slice(NAV_BY_STORYBOARD_ID.length) : null;
        if (segue === null && sbId === null) {
          kept.push(r);
          continue;
        }
        const target = segue !== null ? bySegue.get(segue) : byStoryboardId.get(sbId!);
        if (target && !kept.some((k) => k.navigation && k.path === target && k.line === r.line)) kept.push({ ...r, path: target, handler: target, componentPath: target });
      }
      a.routes = kept;
    }
  },
};
