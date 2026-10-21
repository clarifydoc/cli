import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { enclosingModules } from "./index.js";
import { railsUnderscore } from "./schema.js";

/** `app/views/api/v1/clubs/index.json.jbuilder` → `api/v1/clubs/index`. */
const VIEW_RE = /(?:^|\/)app\/views\/(.+?)(?:\.json)?\.jbuilder$/;

/**
 * Rails renders an action's view by convention: `Api::V1::ClubsController#index`
 * with no `render` of its own answers with `app/views/api/v1/clubs/index.json.jbuilder`.
 * The view is code — it reads the records it lists and may query more
 * (`json.array! @club.players.where(active: true)`) — so the action calls it:
 * a link from the action to the view's top-level statements. A view no action
 * of that controller defines (an implicit action, an inherited one) is left
 * unlinked rather than guessed.
 */
export class RailsViewResolver implements DispatchResolver {
  readonly id = "rails-view";
  readonly languages: Language[] = ["ruby"];
  readonly priority = 56;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = new Map<string, FileAnalysis[]>();
    for (const a of analyses) {
      const key = VIEW_RE.exec(a.filePath)?.[1];
      if (!key || !a.functions.some((f) => f.name === "<setup>")) continue;
      (views.get(key) ?? views.set(key, []).get(key)!).push(a);
    }
    if (views.size === 0) return [];

    const links: SymbolLink[] = [];
    const link = (sourceFile: string, sourceSymbol: string, sourceLine: number, view: FileAnalysis, callName = "render"): void => {
      const setup = view.functions.find((f) => f.name === "<setup>")!;
      if (links.some((l) => l.sourceFile === sourceFile && l.sourceSymbol === sourceSymbol && l.targetFile === view.filePath)) return;
      links.push({ sourceFile, sourceSymbol, sourceLine, callName, targetFile: view.filePath, targetSymbol: setup.name, targetLine: setup.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
    };
    // A keyed render names a template: relative to `dir` unless it states a path;
    // a partial's file starts with `_`.
    const named = (key: string, dir: string): FileAnalysis[] => {
      const m = /^rails-view:(template|partial):(.+)$/.exec(key);
      if (!m) return [];
      const parts = m[2]!.split("/");
      const leaf = parts.pop()!;
      const base = parts.length > 0 ? parts.join("/") : dir;
      return views.get(`${base}/${m[1] === "partial" ? `_${leaf}` : leaf}`) ?? [];
    };
    // A view's partials: `json.partial! 'api/v1/models/club'` from its `<setup>`.
    for (const list of views.values()) {
      for (const view of list) {
        const setup = view.functions.find((f) => f.name === "<setup>")!;
        const dir = VIEW_RE.exec(view.filePath)![1]!.split("/").slice(0, -1).join("/");
        for (const c of setup.calls) if (c.key) for (const p of named(c.key, dir)) if (p !== view) link(view.filePath, setup.name, c.line, p, c.name);
      }
    }
    for (const a of analyses) {
      if (VIEW_RE.test(a.filePath)) continue;
      for (const cls of a.classes) {
        if (!cls.name.endsWith("Controller")) continue;
        const qualified = [...enclosingModules(cls, a.classes), cls.name.split("::").pop()!];
        const dir = qualified.map((s) => railsUnderscore(s)).join("/").replace(/_controller$/, "");
        for (const method of cls.methods) {
          const symbol = `${cls.name}.${method.name}`;
          for (const view of views.get(`${dir}/${method.name}`) ?? []) link(a.filePath, symbol, method.line, view);
          // `render :edit` / `render 'clubs/show'` / `render partial: 'row'`.
          for (const c of method.calls) if (c.key) for (const view of named(c.key, dir)) link(a.filePath, symbol, c.line, view);
        }
      }
    }
    return links;
  }
}
