import type { RouteInfo, ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

/** Rails RESTful action → HTTP method + URL shape */
const RAILS_ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  index:   { method: "GET",    suffix: "" },
  show:    { method: "GET",    suffix: "/:id" },
  new:     { method: "GET",    suffix: "/new" },
  edit:    { method: "GET",    suffix: "/:id/edit" },
  create:  { method: "POST",   suffix: "" },
  update:  { method: "PUT",    suffix: "/:id" },
  destroy: { method: "DELETE", suffix: "/:id" },
};

/**
 * Controllers provided by Rails / its engines, not the application. Routes that
 * point at these (e.g. `get "/rails/mailers" => "rails/mailers#index"`, the
 * dev-only mailer preview) have no project source, so we drop them rather than
 * surface a handler-less "no code" route.
 */
const FRAMEWORK_CONTROLLER_RE = /^(rails|active_admin|action_cable|action_mailbox|active_storage)\b/;

/** `supervision_time_schedules` / `reports/positions` → `SupervisionTimeSchedules` / `Positions` */
function railsCamelize(token: string): string {
  return token
    .split(/[_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** A `controller` token (last segment) → its Rails class name, e.g. `session` → `SessionController`. */
function railsControllerClass(controllerToken: string): string {
  const last = controllerToken.split("/").pop() ?? controllerToken;
  return railsCamelize(last) + "Controller";
}

/** `UserRole` / `Admin::BaseController` → `user_role` / `base_controller` — the
 *  Rails autoload file basename for a constant. Only the last `::` segment
 *  matters because autoloading maps each constant to its own file. */
function railsUnderscore(name: string): string {
  const last = name.split("::").pop() ?? name;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Naive Rails inflector: `user_role` → `user_roles`, `category` → `categories`. */
function railsPluralize(token: string): string {
  if (/[^aeiou]y$/.test(token)) return token.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(token)) return token + "es";
  return token + "s";
}

export const rubySpec: RegexLangSpec = {
  language: "ruby",
  extensions: [".rb"],
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],

  // Ruby: `self.service.method()` and `ClassName.method()`
  callPatterns: [
    {
      pattern: /self\.(\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `self.${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  classPatterns: [
    {
      // Capture the FULL (possibly namespaced) class name — `IstLoen::KmdIndberetning`,
      // not just the first segment `IstLoen` (which collided with the IstLoen concern).
      pattern: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)/,
      getExtends: (line) => {
        // Superclass may be namespaced too (`< ActiveRecord::Base`, `< IstLoen::Base`).
        const m = line.match(/<\s*([A-Z][\w:]*)/);
        return m?.[1] ?? null;
      },
    },
    { pattern: /^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/, getExtends: () => null },
  ],

  /**
   * Wrap the generic class extractor to attach module mixins
   * (`include`/`extend`/`prepend`) as `implements` edges. Ruby's mixin model
   * is closer to interface-implementation than inheritance, so this maps
   * naturally onto the existing field.
   */
  extractClasses: (lines: string[], fns: FunctionInfo[]) => {
    const classes = extractClassesWithSpec(lines, rubySpec);
    if (classes.length === 0) return classes;

    for (const cls of classes) {
      // Scan the class body for include/extend/prepend statements.
      // Each one names a module that ought to count as a relationship for
      // the data-model graph. Lines outside the class's body range are
      // ignored, so module mixins from sibling classes don't bleed.
      const seen = new Set<string>(cls.implements ?? []);
      for (let i = cls.line; i < cls.endLine && i < lines.length; i++) {
        const line = lines[i] ?? "";
        // include Foo, Bar    /   extend Foo    /   prepend Foo
        const mixinMatch = line.match(/^\s*(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/);
        if (!mixinMatch) continue;
        for (const name of mixinMatch[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!seen.has(name)) {
            seen.add(name);
            cls.implements.push(name);
          }
        }
      }
    }
    // Suppress the now-duplicated methods from the top-level functions list,
    // mirroring what regex-extractor.ts does for any spec providing
    // extractClasses.
    return classes;
  },

  importPatterns: [
    {
      pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
    {
      // Rails autoload: `ActiveAdmin.register UserRole` administers (and thus
      // depends on) the `UserRole` model — there's no `require`, the constant
      // reference autoloads app/models/user_role.rb. Surfacing it as an import
      // lets the dependency graph link the admin file to its model.
      pattern: /^\s*ActiveAdmin\.register\s+([A-Z][\w:]*)/,
      getSource: (m) => railsUnderscore(m[1]),
      getSpecifiers: (m) => [m[1].split("::").pop() ?? m[1]],
    },
    {
      // Rails autoload via inheritance: `class Foo < Bar` loads Bar's file
      // (e.g. a controller's ApplicationController, a model's IdaModel). The
      // superclass is already captured as an `extends` edge for the data-model
      // graph; emitting it as an import additionally wires the file-level
      // dependency graph the same way `require` would.
      pattern: /^\s*class\s+[A-Z]\w*\s+<\s+([A-Z][\w:]*)/,
      getSource: (m) => railsUnderscore(m[1]),
      getSpecifiers: (m) => [m[1].split("::").pop() ?? m[1]],
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];

    // ActiveAdmin DSL. `ActiveAdmin.register Model do … end` mounts the standard
    // admin CRUD routes under `/admin/<pluralized_resource>`; the generated
    // controller is `Admin::<Model>sController`, but its customisations live in
    // THIS file, so the routes are attributed here. `register_page "Title"`
    // mounts a single GET page.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const reg = line.match(/^ActiveAdmin\.register\s+([A-Z][\w:]*)/);
      if (reg) {
        const model = reg[1].split("::").pop() ?? reg[1];
        const resource = railsPluralize(railsUnderscore(model));
        const basePath = "/admin/" + resource;
        // The generated controller is `Admin::<Plural>Controller`. We carry it
        // as the handler for display, but WITHOUT an `#action` suffix: the
        // symbol linker resolves handlers by their leaf name, and the REST
        // action leaves (`index`, `show`, …) collide with every real
        // controller's methods, producing bogus cross-file edges. The bare
        // class name matches no project symbol, so no false link is emitted.
        const controllerClass = "Admin::" + railsCamelize(resource) + "Controller";
        for (const [action, info] of Object.entries(RAILS_ACTION_MAP)) {
          void action;
          routes.push({
            path: basePath + info.suffix,
            httpMethod: info.method,
            kind: "api",
            handler: controllerClass,
            calls: [],
            middleware: [],
            line: i + 1,
          });
        }
        continue;
      }
      const page = line.match(/^ActiveAdmin\.register_page\s+['"]([^'"]+)['"]/);
      if (page) {
        routes.push({
          path: "/admin/" + railsUnderscore(page[1].replace(/\s+/g, "_")),
          httpMethod: "GET",
          kind: "api",
          handler: null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
    }

    // Scan for `private` keyword to mark lines below it as private
    const privateMethodLines = new Set<number>();
    let inPrivateBlock = false;
    let privateBlockIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (/^private\s*$/.test(trimmed) || /^private\s+/.test(trimmed)) {
        inPrivateBlock = true;
        privateBlockIndent = indent;
        continue;
      }
      if (/^(public|protected)\b/.test(trimmed)) {
        inPrivateBlock = false;
        continue;
      }
      if (inPrivateBlock && trimmed !== "" && indent < privateBlockIndent) {
        inPrivateBlock = false;
      }
      if (inPrivateBlock) privateMethodLines.add(i + 1);
    }

    // Convention: XxxController classes map methods to REST routes
    for (const cls of classes) {
      const match = cls.name.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (cls.name === "ApplicationController" || cls.name === "ActionController") continue;

      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = "/" + resource;

      for (const method of cls.methods) {
        if (privateMethodLines.has(method.line)) continue;
        if (method.name.endsWith("?") || method.name.endsWith("!")) continue;
        if (method.name.startsWith("_")) continue;

        const action = RAILS_ACTION_MAP[method.name];
        if (action) {
          routes.push({
            path: basePath + action.suffix,
            httpMethod: action.method,
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        } else {
          routes.push({
            path: basePath + "/" + method.name,
            httpMethod: "GET",
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        }
      }
    }

    // config/routes.rb: resolve paths through namespace/scope nesting, extract
    // the `controller#action` handler so routes link to their controller code,
    // and expand multi-resource / multi-line `resources` declarations.
    //
    // `blockStack` carries one entry per `end`-terminated block (namespace/scope
    // contribute a path prefix; every other block — `if`, `do`, nested
    // `resources do` — contributes ""), so `end` always pops exactly one frame.
    const blockStack: string[] = [];
    const currentPrefix = () => blockStack.join("");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;

      // `end` closes the most recent block.
      if (/^end\b/.test(line)) {
        blockStack.pop();
        continue;
      }

      const opensDoBlock = /\bdo\b(\s*\|[^|]*\|)?$/.test(line);

      // namespace :x do / scope '/x' do — open a block that prefixes child paths.
      const nsMatch = line.match(/^namespace\s+:(\w+)/);
      if (nsMatch && opensDoBlock) {
        blockStack.push("/" + nsMatch[1]);
        continue;
      }
      const scopeMatch = line.match(/^scope\s+['"]([^'"]+)['"]/);
      if (scopeMatch && opensDoBlock) {
        const p = scopeMatch[1].replace(/^\/?/, "/");
        blockStack.push(p === "/" ? "" : p);
        continue;
      }

      // resources :a, :b, :only => [...] — may span multiple lines (trailing comma).
      const resourcesMatch = line.match(/^(resources?)\b/);
      if (resourcesMatch) {
        let stmt = line;
        while (/,\s*$/.test(stmt) && i + 1 < lines.length) {
          stmt += " " + lines[++i].trim();
        }
        // Take the leading :symbol list, before any option (only:/except:/=>).
        const beforeOpts = stmt.slice(resourcesMatch[1].length).split(/\b(?:only|except)\b|=>/)[0];
        for (const m of beforeOpts.matchAll(/:(\w+)/g)) {
          routes.push({
            path: currentPrefix() + "/" + m[1],
            httpMethod: null,
            kind: "api",
            handler: railsControllerClass(m[1]),
            calls: [],
            middleware: [],
            line: i + 1,
          });
        }
        if (opensDoBlock) blockStack.push(""); // `resources :x do` opens a nested block
        continue;
      }

      // get/post/put/patch/delete 'path' [=> 'ctrl#action' | to: 'ctrl#action']
      const verbMatch = line.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/);
      if (verbMatch) {
        const rawPath = verbMatch[2];
        const target = line.match(/(?:=>|to:)\s*['"]([^'"#]+)#(\w+)['"]/);
        let controller: string | null = null;
        let action: string | null = null;
        if (target) {
          controller = target[1];
          action = target[2];
        } else if (rawPath.includes("/")) {
          // Implicit `controller/action` convention (e.g. `get 'absences/vacation_days'`).
          const segs = rawPath.split("/").filter((s) => s && !s.startsWith(":") && !s.startsWith("*"));
          if (segs.length >= 2) {
            action = segs[segs.length - 1];
            controller = segs.slice(0, -1).join("/");
          }
        }

        // Framework-internal controllers have no project code — skip the route.
        if (controller && FRAMEWORK_CONTROLLER_RE.test(controller)) continue;

        routes.push({
          path: currentPrefix() + (rawPath.startsWith("/") ? rawPath : "/" + rawPath),
          httpMethod: verbMatch[1].toUpperCase(),
          kind: "api",
          handler: controller && action ? `${railsControllerClass(controller)}#${action}` : null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
        continue;
      }

      // Any other `end`-terminated block (if/unless/case/do/...) — track depth
      // so a later `end` doesn't pop a namespace/scope prefix prematurely.
      const opensIfBlock = /^(if|unless|case|begin|while|until|module|class|def)\b/.test(line);
      if (opensDoBlock || opensIfBlock) blockStack.push("");
    }

    return routes;
  },
};
