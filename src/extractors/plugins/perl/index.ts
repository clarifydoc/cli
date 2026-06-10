import type { RouteInfo, ClassInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Moose / Moo style attribute declaration:
 *   has 'name'  => (is => 'ro', isa => 'Str');
 *   has user    => (isa => 'User', is => 'rw');
 *   has 'items' => (isa => 'ArrayRef[Item]');
 *
 * Pulls both the attribute name and the `isa` type into a PropertyInfo so
 * the field shows up on the class with a meaningful `type` for the
 * data-model graph. Without this Perl classes look empty even when they
 * have rich attribute declarations.
 */
function parseMooseHas(line: string): PropertyInfo | null {
  const head = line.match(/^\s*has\s+(?:['"]([A-Za-z_][\w-]*)['"]|([A-Za-z_]\w*))\s*=>/);
  if (!head) return null;
  const name = head[1] ?? head[2];
  if (!name) return null;
  const isaMatch = line.match(/isa\s*=>\s*['"]([^'"]+)['"]/);
  return {
    name,
    type: isaMatch?.[1] ?? null,
    visibility: "public",
    isStatic: false,
    isReadonly: /is\s*=>\s*['"]ro['"]/.test(line),
  };
}

export const perlSpec: RegexLangSpec = {
  language: "perl",
  extensions: [".pl", ".pm"],
  indentBased: false,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      // sub foo { ... } or sub foo : attr { ... } or sub foo ($x, $y) { ... }
      // Catalyst: sub foo :Path('/x') :Args(0) { ... }
      pattern: /^\s*sub\s+([a-zA-Z_]\w*)\s*(?:[:(]|\{)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],

  // Perl packages are file-scoped, not block-scoped — see `extractClasses` below.
  classPatterns: [],

  extractClasses: (lines, fns) => {
    // Find all package declarations with their line numbers (and implicit end lines)
    const pkgs: { name: string; line: number; endLine: number; extends: string | null; implements: string[] }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*package\s+([A-Za-z_][\w:]*)/);
      if (m) {
        pkgs.push({ name: m[1], line: i + 1, endLine: lines.length, extends: null, implements: [] });
      }
    }

    // Each package ends where the next one begins (or EOF)
    for (let i = 0; i < pkgs.length - 1; i++) {
      pkgs[i].endLine = pkgs[i + 1].line - 1;
    }

    // Scan each package's line range for parent classes via `use parent` / `use base` / `extends`
    for (const pkg of pkgs) {
      for (let i = pkg.line; i < pkg.endLine && i < lines.length; i++) {
        const line = lines[i];
        const parentMatch = line.match(/\buse\s+(?:parent|base)\s+['"]([A-Za-z_][\w:]*)['"]/)
          ?? line.match(/\buse\s+(?:parent|base)\s+qw\s*[([]\s*([A-Za-z_][\w:]*)/)
          ?? line.match(/\bextends\s+['"]([A-Za-z_][\w:]*)['"]/);
        if (parentMatch && !pkg.extends) {
          pkg.extends = parentMatch[1];
        }
        const roleMatch = line.match(/^\s*with\s+['"]([A-Za-z_][\w:]*)['"]/);
        if (roleMatch) pkg.implements.push(roleMatch[1]);
      }
    }

    // Attach functions and Moose-style attributes to their owning package
    // based on line ranges.
    return pkgs.map((pkg) => {
      const methods = fns.filter((fn) => fn.line >= pkg.line && fn.line <= pkg.endLine);
      const properties: PropertyInfo[] = [];
      for (let i = pkg.line; i < pkg.endLine && i < lines.length; i++) {
        const prop = parseMooseHas(lines[i] ?? "");
        if (prop) properties.push(prop);
      }
      return {
        name: pkg.name,
        extends: pkg.extends,
        implements: pkg.implements,
        decorators: [],
        methods,
        properties,
        isExported: true,
        line: pkg.line,
        endLine: pkg.endLine,
      };
    });
  },

  importPatterns: [
    {
      // use Foo::Bar;  use Foo::Bar qw(func1 func2);
      pattern: /^\s*use\s+([A-Za-z_][\w:]*)(?:\s+qw\s*[([]([^)\]]*)[)\]])?/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        if (m[2]) return m[2].trim().split(/\s+/).filter(Boolean);
        const parts = m[1].split("::");
        return [parts[parts.length - 1]];
      },
    },
    {
      // require Foo::Bar;
      pattern: /^\s*require\s+([A-Za-z_][\w:]*)\s*;/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split("::");
        return [parts[parts.length - 1]];
      },
    },
    {
      // extends 'Catalyst::Controller';  (inside BEGIN blocks too)
      pattern: /^\s*extends\s+['"]([A-Za-z_][\w:]*)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split("::");
        return [parts[parts.length - 1]];
      },
    },
  ],

  extractRoutes: (lines, _classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];

    // Catalyst: sub action_name :Path('/uri') :Args(n) :Method('GET') { ... }
    // Also: :Local (uses action name as path), :Global, :Chained
    for (let i = 0; i < lines.length; i++) {
      // Attributes can span the `sub` line or continue on next line
      const subMatch = lines[i].match(/^\s*sub\s+(\w+)\s*:(.+)$/);
      if (!subMatch) continue;

      const actionName = subMatch[1];
      // Collect attributes from this line and continuation lines until we hit `{`
      let attrText = ":" + subMatch[2];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].includes("{")) {
          attrText += " " + lines[j].substring(0, lines[j].indexOf("{"));
          break;
        }
        attrText += " " + lines[j];
      }

      // :Path('/users') or :Path("/users") or :Path (uses action name)
      // :Local / :Global / :Chained('parent')
      let path: string | null = null;
      let httpMethod: string | null = null;

      const pathMatch = attrText.match(/:Path\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      const localMatch = attrText.match(/:Local\b/);
      const globalMatch = attrText.match(/:Global\b/);
      const methodMatch = attrText.match(/:Method\s*\(\s*['"](\w+)['"]\s*\)/);

      if (pathMatch) {
        path = pathMatch[1];
      } else if (globalMatch) {
        path = "/" + actionName;
      } else if (localMatch) {
        // :Local is relative to controller namespace; we don't know it here, so use action name
        path = "/" + actionName;
      }

      if (methodMatch) httpMethod = methodMatch[1].toUpperCase();

      if (path) {
        routes.push({
          path,
          httpMethod,
          kind: "api",
          handler: actionName,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
    }

    return routes;
  },
};
