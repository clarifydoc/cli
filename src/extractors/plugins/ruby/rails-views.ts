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
    for (const a of analyses) {
      if (VIEW_RE.test(a.filePath)) continue;
      for (const cls of a.classes) {
        if (!cls.name.endsWith("Controller")) continue;
        const qualified = [...enclosingModules(cls, a.classes), cls.name.split("::").pop()!];
        const dir = qualified.map((s) => railsUnderscore(s)).join("/").replace(/_controller$/, "");
        for (const method of cls.methods) {
          for (const view of views.get(`${dir}/${method.name}`) ?? []) {
            const setup = view.functions.find((f) => f.name === "<setup>")!;
            links.push({
              sourceFile: a.filePath,
              sourceSymbol: `${cls.name}.${method.name}`,
              sourceLine: method.line,
              callName: "render",
              targetFile: view.filePath,
              targetSymbol: setup.name,
              targetLine: setup.line,
              resolvedBy: "text",
              confidence: "INFERRED",
              relation: "dispatch",
            });
          }
        }
      }
    }
    return links;
  }
}
