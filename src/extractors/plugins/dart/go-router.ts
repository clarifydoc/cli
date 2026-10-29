import type { FileAnalysis, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/**
 * GoRouter routes. `GoRoute(path: '/home', …)` is a screen at a literal path;
 * the common form names a constant of the screen instead —
 *
 *   GoRoute(                                    // router.dart
 *     path: MobileHomeScreen.routeName,
 *     pageBuilder: (c, s) => MaterialExtendedPage(child: const MobileHomeScreen()),
 *   )
 *   static const routeName = '/home';           // mobile_home_screen.dart
 *
 * Per file the plugin records each such route as a fact (the class, the
 * field and the widget it builds); this pass reads the field's value off the
 * class the name resolves to and adds the route.
 */
export const GO_ROUTE_FACT = "dart:go-route";

interface GoRouteFact {
  cls: string;
  field: string;
  widget: string | null;
  shell?: RouteInfo["shell"];
}

const PATH_RE = /\bpath\s*:\s*(?:'([^']*)'|"([^"]*)"|([A-Z]\w*)\.(\w+))/;

/** The text of the call opening at `open` on line `i`, up to its closing paren (`max` lines at most). */
function callText(lines: string[], i: number, open: number, max = 30): string {
  let depth = 0;
  let out = "";
  for (let k = i; k < Math.min(lines.length, i + max); k++) {
    const line = k === i ? lines[k]!.slice(open) : lines[k]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return out + line.slice(0, c + 1);
    }
    out += line + "\n";
  }
  return out;
}

/**
 * The widget a route builds: the page's `child:`, else what its builder returns.
 * A child held in a variable names no widget — the page wrapper around it is not the screen.
 */
function widgetOf(text: string): string | null {
  const child = /\bchild\s*:\s*(?:const\s+)?([A-Za-z_]\w*)\s*[(,)\n]/.exec(text);
  if (child) return /^[A-Z]/.test(child[1]!) ? child[1]! : null;
  return /(?:=>|\breturn)\s*(?:const\s+)?([A-Z]\w*)\s*\(/.exec(text)?.[1] ?? null;
}

/**
 * The GoRoutes a file declares: literal paths as routes, constant paths as
 * facts for {@link goRouterResolver}. A nested route's own `routes: [...]` come
 * on later lines and are read there.
 */
export function goRoutes(lines: string[], facts: RouteFact[] | undefined): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const shells = shellsByLine(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    for (const m of line.matchAll(/\bGoRoute\s*\(/g)) {
      const text = callText(lines, i, m.index!);
      // Only this route's own arguments: a child route's `path:` sits inside its `routes: [`.
      const own = text.split(/\broutes\s*:\s*\[/)[0]!;
      const path = PATH_RE.exec(own);
      if (!path) continue;
      const widget = widgetOf(own);
      const shell = shells.get(i);
      if (path[3]) {
        facts?.push({ kind: GO_ROUTE_FACT, line: i + 1, data: { cls: path[3], field: path[4]!, widget, ...(shell ? { shell } : {}) } satisfies GoRouteFact });
        continue;
      }
      routes.push({ path: path[1] ?? path[2]!, httpMethod: null, kind: "frontend", handler: widget, ...(widget ? { componentPath: widget } : {}), ...(shell ? { shell } : {}), calls: [], middleware: [], line: i + 1 });
    }
  }
  return routes;
}

/**
 * The shells around GoRoutes, by the line each route opens on: a `StatefulShellRoute`'s builder
 * widget (`MobileBottomNavigationBar(navigationShell: …)`) frames its branches, each branch's
 * first route being what its tab opens; a `ShellRoute`'s frames every route of its `routes:`.
 */
function shellsByLine(lines: string[]): Map<number, NonNullable<RouteInfo["shell"]>> {
  const out = new Map<number, NonNullable<RouteInfo["shell"]>>();
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(StatefulShellRoute|ShellRoute)\b(?:\.\w+)?\s*\(/.exec(lines[i]!);
    if (!m || /^\s*\/\//.test(lines[i]!)) continue;
    const text = callText(lines, i, m.index, 400);
    const head = text.split(/\b(?:branches|routes)\s*:/)[0]!;
    const component = /(?:=>|\breturn)\s*(?:const\s+)?([A-Z]\w*)\s*\(/.exec(head)?.[1];
    if (!component) continue;
    const end = i + text.split("\n").length;
    const stateful = m[1] === "StatefulShellRoute";
    let branchOpen = false;
    for (let k = i + 1; k < end && k < lines.length; k++) {
      if (/\bStatefulShellBranch\s*\(/.test(lines[k]!)) branchOpen = true;
      if (!/\bGoRoute\s*\(/.test(lines[k]!) || out.has(k)) continue;
      if (stateful) {
        if (!branchOpen) continue;
        branchOpen = false;
        out.set(k, { component, tab: true });
      } else out.set(k, { component });
    }
  }
  return out;
}

export const goRouterResolver: RouteResolver = {
  id: "go-router-constants",
  languages: ["dart"],
  priority: 45,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    for (const a of analyses) {
      for (const fact of a.routeFacts ?? []) {
        if (fact.kind !== GO_ROUTE_FACT) continue;
        const { cls, field, widget, shell } = fact.data as GoRouteFact;
        const path = ctx.classes.resolve(a.filePath, cls)?.cls.fieldValues?.[field];
        if (!path) continue;
        a.routes.push({ path, httpMethod: null, kind: "frontend", handler: widget ?? cls, componentPath: widget ?? cls, ...(shell ? { shell } : {}), calls: [], middleware: [], line: fact.line });
      }
    }
  },
};
