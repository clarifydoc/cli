import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Blade view → controller action. A form or link in a Blade template requests
 * a named route (`<form action="{{ route('clubs.update', $club) }}">`, read as
 * `route:clubs.update`) or a literal app path (`href="/clubs"`); the Laravel
 * routes say which `Controller#action` serves it. The link goes from the
 * element's handler to the action's method, so a button in a view traces into
 * the controller and on to the models it touches. A named route is matched by
 * its name alone (a form spoofs its verb with `@method`); a literal path by
 * path and verb, a POST form standing for any write verb. Controllers are
 * found by class name in the view's sub-project, one definition only.
 */

const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class LaravelViewResolver implements DispatchResolver {
  readonly id = "laravel-view";
  readonly languages: Language[] = ["php"];
  readonly priority = 57;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = analyses.filter((a) => a.interactiveElements.some((e) => e.request));
    if (views.length === 0) return [];

    type Served = { projectId: string | undefined; handler: string; owner?: string };
    const byName = new Map<string, Served[]>();
    const byPath: Array<Served & { verb: string | null; re: RegExp }> = [];
    const classes = new Map<string, Array<{ a: FileAnalysis; methods: Map<string, number> }>>();
    for (const a of analyses) {
      for (const cls of a.classes) {
        const list = classes.get(cls.name) ?? classes.set(cls.name, []).get(cls.name)!;
        list.push({ a, methods: new Map(cls.methods.map((m) => [m.name, m.line])) });
      }
      for (const r of a.routes) {
        if (r.kind !== "api" || !r.handler?.includes("#")) continue;
        const served: Served = { projectId: a.projectId, handler: r.handler, ...(r.owner ? { owner: r.owner } : {}) };
        if (r.name) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(served);
        const pattern = r.path.split("/").map((s) => (/^\{.*\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
        byPath.push({ ...served, verb: r.httpMethod, re: new RegExp(`^${pattern}/?$`) });
      }
    }
    if (byName.size === 0 && byPath.length === 0) return [];

    // Same-named controllers (`Squad\ShowController`, `Club\ShowController`) are told apart by the
    // namespace the route's qualified controller (`owner`) states.
    const actionSite = (served: Served, projectId: string | undefined): { file: string; symbol: string; line: number } | null => {
      const [ctl, action] = served.handler.split("#");
      let owners = (classes.get(ctl!) ?? []).filter((c) => c.a.projectId === projectId && c.methods.has(action!));
      const ns = served.owner?.includes("\\") ? served.owner.slice(0, served.owner.lastIndexOf("\\")).toLowerCase() : null;
      if (owners.length > 1 && ns) owners = owners.filter((c) => c.a.declaredNamespace?.replace(/^\\/, "").toLowerCase() === ns);
      if (owners.length !== 1) return null;
      return { file: owners[0]!.a.filePath, symbol: `${ctl}.${action}`, line: owners[0]!.methods.get(action!)! };
    };

    const links: SymbolLink[] = [];
    const emitted = new Set<string>();
    for (const view of views) {
      for (const el of view.interactiveElements) {
        if (!el.request || !el.handler) continue;
        const { method, target } = el.request;
        const served = target.startsWith("route:")
          ? (byName.get(target.slice(6)) ?? []).filter((r) => r.projectId === view.projectId)
          : target.startsWith("/")
            ? byPath.filter((r) => r.projectId === view.projectId && r.re.test(target.replace(/:param/g, "x").replace(/\/$/, "") || "/")
              && (r.verb === null || r.verb === method || (method === "POST" && WRITE_VERBS.has(r.verb))))
            : [];
        for (const s of served) {
          const site = actionSite(s, view.projectId);
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
