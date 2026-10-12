import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { singularize } from "../shared/inflection.js";
import { railsUnderscore } from "../ruby/schema.js";

/** The REST actions a resource route gets without naming them in its path. */
const RESTFUL = new Set(["index", "create", "show", "update", "destroy", "new", "edit"]);

/**
 * The route helper Rails names a route by, from its path and action:
 * `/users/:id/edit` edit → `edit_user`, `/accounts/:account_id/conversations` →
 * `account_conversations`, `/super_admin/accounts/:id/seed` seed →
 * `seed_super_admin_account`. A static segment followed by a parameter is a
 * member (singular); parameters drop out; a custom member or collection action
 * prefixes the name. An explicit `as:` is not visible here — those routes keep
 * the derived name and may not match.
 */
export function railsRouteHelper(path: string, action: string): string {
  const segs = path.replace(/\(\.:format\)$/, "").split("/").filter(Boolean);
  let prefix: string | null = null;
  const last = segs[segs.length - 1];
  if (last && !last.startsWith(":") && !last.startsWith("*") && last === action && !RESTFUL.has(action)) {
    prefix = action;
    segs.pop();
  } else if (last === "new" || last === "edit") {
    prefix = last;
    segs.pop();
  }
  const parts: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.startsWith(":") || s.startsWith("*")) continue;
    const next = segs[i + 1];
    parts.push((next !== undefined && next.startsWith(":")) || ((prefix === "new") && i === segs.length - 1) ? singularize(s) : s);
  }
  return [prefix, ...parts].filter(Boolean).join("_").replace(/-/g, "_");
}

const sameVerb = (a: string | null, b: string): boolean =>
  a === null || a === b || ((a === "PUT" || a === "PATCH") && (b === "PUT" || b === "PATCH"));

/**
 * Rails view → controller action. An ERB element's `request` names a route
 * helper (`edit_user_path`) or a literal path; the Rails routes (`config/routes.rb`
 * and the controller-convention routes the Ruby plugin emits, handler
 * `Ctl#action`) say which action serves it. The link goes from the view's
 * handler symbol to the action's method, so a button in a view traces into the
 * controller and on to the models it touches. Each handler joins only routes
 * serving its verb (PUT and PATCH alike); a helper several routes share under
 * one verb links to each.
 */
export class RailsViewResolver implements DispatchResolver {
  readonly id = "rails-view";
  readonly languages: Language[] = ["erb", "ruby"];
  readonly priority = 40;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = analyses.filter((a) => a.language === "erb" && a.interactiveElements.some((e) => e.request));
    if (views.length === 0) return [];
    const ruby = analyses.filter((a) => a.language === "ruby");

    // Controller actions by `Ctl#action`, found where Rails loads the class from.
    const fileByPath = new Map(ruby.map((a) => [a.filePath, a]));
    const actionSite = (handler: string): { file: string; symbol: string; line: number } | null => {
      const [ctl, action] = handler.split("#");
      if (!ctl || !action) return null;
      const suffix = `controllers/${ctl.split("::").map(railsUnderscore).join("/")}.rb`;
      const leaf = ctl.split("::").pop()!;
      for (const [path, a] of fileByPath) {
        if (!path.endsWith(suffix)) continue;
        for (const cls of a.classes) {
          if (cls.name !== ctl && cls.name.split("::").pop() !== leaf) continue;
          const m = cls.methods.find((x) => x.name === action);
          if (m) return { file: path, symbol: `${cls.name}.${action}`, line: m.line };
        }
      }
      return null;
    };

    const byHelper = new Map<string, Array<{ verb: string | null; handler: string }>>();
    const byPath: Array<{ verb: string | null; re: RegExp; handler: string }> = [];
    const seen = new Set<string>();
    for (const a of ruby) {
      for (const r of a.routes) {
        if (!r.handler?.includes("#")) continue;
        const key = `${r.httpMethod}\0${r.path}\0${r.handler}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const action = r.handler.split("#")[1]!;
        const helper = railsRouteHelper(r.path, action);
        // `root to:` inside a namespace is named `<namespace>_root` (top level: `root`).
        const helpers = action === "index" && r.httpMethod === "GET" ? [helper, helper ? `${helper}_root` : "root"] : [helper];
        for (const h of helpers) {
          const list = byHelper.get(h) ?? [];
          list.push({ verb: r.httpMethod, handler: r.handler });
          byHelper.set(h, list);
        }
        const pattern = r.path.replace(/\(\.:format\)$/, "").split("/").map((s) => (s.startsWith(":") || s.startsWith("*") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
        byPath.push({ verb: r.httpMethod, re: new RegExp(`^${pattern}/?$`), handler: r.handler });
      }
    }

    const links: SymbolLink[] = [];
    const emitted = new Set<string>();
    for (const view of views) {
      for (const el of view.interactiveElements) {
        if (!el.request || !el.handler) continue;
        const { method, target } = el.request;
        const candidates = target.startsWith("/")
          ? byPath.filter((r) => r.re.test(target.replace(/\/$/, "") || "/"))
          : byHelper.get(target.replace(/_(?:path|url)$/, "")) ?? [];
        for (const c of candidates) {
          if (!sameVerb(c.verb, method)) continue;
          const site = actionSite(c.handler);
          if (!site) continue;
          const key = `${view.filePath}\0${el.handler}\0${site.file}\0${site.symbol}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          links.push({
            sourceFile: view.filePath,
            sourceSymbol: el.handler,
            sourceLine: el.line,
            callName: el.handler,
            targetFile: site.file,
            targetSymbol: site.symbol,
            targetLine: site.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
