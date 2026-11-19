import type { FileAnalysis, RouteInfo, ScreenInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/**
 * The route that renders a Rails view, for a form that posts to its own page.
 *
 * A view with a POST form naming no URL (`form_with scope: :club`, `<form method="post">`) posts to the
 * address it was served from. Core joins that post to the route rendering the page (`ScreenInfo.renderedBy`),
 * which it finds from a template named in the action's code — and an action that renders implicitly names
 * none. The view `clubs/join` is the page of `ClubsController#join` when the router gives that action ONE
 * GET path and its body hands the browser nowhere else (no `render`, `redirect_to`, `head`, `respond_to`,
 * `send_*`). A view served at two paths, or by an action that may render another page, says nothing.
 * Every such view is the page of its route, which is what lets a link to it (`link_to "Club", club_path(@club)`,
 * resolved to the path through the route's name) draw an edge on the screen map.
 */
export const railsOwnView: RouteResolver = {
  id: "rails-own-view",
  languages: ["ruby", "erb"],
  priority: 60,
  resolve(analyses: FileAnalysis[]): void {
    const views = analyses.filter((a) => a.language === "erb" && a.screens?.some((s) => !s.renderedBy?.length));
    if (views.length === 0) return;
    const ruby = analyses.filter((a) => a.language === "ruby");

    const camel = (s: string): string => s.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
    /** The GET rows of an action, by its `Ctl#action` handler. */
    const rowsOf = new Map<string, Array<RouteInfo & { filePath: string }>>();
    for (const a of ruby) {
      for (const r of a.routes) {
        if (r.kind !== "api" || r.httpMethod !== "GET" || !r.handler?.includes("#")) continue;
        (rowsOf.get(r.handler) ?? rowsOf.set(r.handler, []).get(r.handler)!).push({ ...r, filePath: a.filePath });
      }
    }
    /** The actions whose body answers the request itself (the Ruby plugin's `rails-action-exits` facts), by `Leaf#action`. */
    const exits = new Set<string>();
    for (const a of ruby) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== "rails-action-exits") continue;
        const d = f.data as { controller: string; action: string };
        exits.add(`${d.controller.split("::").pop()}#${d.action}`);
      }
    }
    /** The class declarations of that leaf name (a namesake in another namespace counts: doubt refuses). */
    const classesOf = (leaf: string) => ruby.flatMap((a) => a.classes.filter((c) => c.name.split("::").pop() === leaf));
    /**
     * The bodies of the action a controller answers, with the leaf of the class that defines them: its own, else
     * the nearest base's (`class Secured < BaseClubs` serves the base's `join`, redirect and all).
     */
    const bodiesOf = (controller: string, action: string) => {
      let leaf = controller.split("::").pop()!;
      for (const seen = new Set<string>(); !seen.has(leaf); ) {
        seen.add(leaf);
        const declared = classesOf(leaf);
        const found = declared.flatMap((c) => c.methods.filter((f) => f.name === action));
        if (found.length > 0) return { leaf, found, doubt: false };
        const bases = new Set(declared.map((c) => c.extends?.split("::").pop()).filter((b): b is string => !!b));
        if (bases.size === 0) break;
        // Two bases, or a base of the same leaf name (`Admin::Clubs < Clubs`): doubt refuses.
        if (bases.size > 1 || seen.has([...bases][0]!)) return { leaf, found: [], doubt: true };
        leaf = [...bases][0]!;
      }
      return { leaf: controller.split("::").pop()!, found: [], doubt: false };
    };

    for (const view of views) {
      for (const screen of view.screens ?? []) {
        if (screen.renderedBy?.length) continue;
        const key = /^(.*)#([^#]+)$/.exec(screen.name);
        if (!key || key[1] === "application") continue;
        const controller = `${key[1]!.split("/").map(camel).join("::")}Controller`;
        const handler = `${controller}#${key[2]}`;
        const rows = rowsOf.get(handler) ?? [];
        if (new Set(rows.map((r) => r.path)).size !== 1) continue;
        const { leaf, found, doubt } = bodiesOf(controller, key[2]!);
        if (doubt) continue;
        if (exits.has(`${controller.split("::").pop()}#${key[2]}`) || exits.has(`${leaf}#${key[2]}`)) continue;
        if (found.some((body) => body.calls.some((c) => /^(?:render|redirect_to|redirect_back|head|respond_to|send_data|send_file)/.test(c.name.split(".").pop() ?? "")))) continue;
        const r = rows[0]!;
        const by: NonNullable<ScreenInfo["renderedBy"]>[number] = { filePath: r.filePath, method: "GET", path: r.path, line: r.line };
        screen.renderedBy = [by];
        if (!screen.routePath) screen.routePath = r.path;
      }
    }
  },
};
