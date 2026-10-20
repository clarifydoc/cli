import type { FileAnalysis, Language, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/**
 * Screens that are classes: an Android `Activity` / `Fragment`, an iOS
 * `UIViewController`. A class is one when its base-class chain reaches one of
 * the platform's screen classes — through the classes the project declares,
 * across files (`OrderActivity : BaseActivity`, `BaseActivity :
 * AppCompatActivity`), never by name suffix. Each becomes a frontend route
 * named by the class, in its file, which the screen builder turns into a
 * screen; a `navigation` row naming the class (`Intent(this,
 * OrderActivity::class.java)`, `pushViewController(OrderViewController(), …)`)
 * is then an edge to it.
 */
export function screenClassResolver(id: string, languages: readonly Language[], bases: ReadonlySet<string>): RouteResolver {
  return {
    id,
    languages,
    priority: 40,
    resolve(analyses: FileAnalysis[]): void {
      const own = analyses.filter((a) => languages.includes(a.language as Language));
      const parentOf = new Map<string, string>();
      for (const a of own) for (const c of a.classes) if (c.extends) parentOf.set(c.name, simple(c.extends));
      const isScreen = (name: string): boolean => {
        let cur: string | undefined = name;
        for (let hops = 0; cur && hops < 8; hops++) {
          if (bases.has(cur)) return hops > 0;
          cur = parentOf.get(cur);
        }
        return false;
      };
      for (const a of own) {
        const rows: RouteInfo[] = [];
        for (const c of a.classes) {
          // An abstract base is not a screen a user opens; its subclasses are.
          if (!isScreen(c.name) || /^(?:Base|Abstract)[A-Z]/.test(c.name) || c.decorators?.includes("abstract")) continue;
          if (a.routes.some((r) => r.kind === "frontend" && !r.navigation && r.path === c.name)) continue;
          rows.push({ path: c.name, httpMethod: null, kind: "frontend", handler: c.name, componentPath: c.name, calls: [], middleware: [], line: c.line });
        }
        if (rows.length) a.routes = [...a.routes, ...rows];
      }
    },
  };
}

/** `androidx.appcompat.app.AppCompatActivity` / `AppCompatActivity()` / `Fragment(R.layout.x)` → the class name. */
function simple(written: string): string {
  return written.replace(/\(.*$/s, "").replace(/<.*$/s, "").trim().split(".").pop()!;
}
