import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import type { DataSourceInfo, ImportInfo } from "../../../types/analysis.js";
import { attachEctoSchema, attachPatternKeys, extractEctoRelations, extractElixirRequestAccess, extractPhoenixRoutes } from "./phoenix.js";

/** Last dotted segment of an Elixir module alias (`MyApp.Accounts.User` → `User`). */
function lastSeg(mod: string): string {
  const parts = mod.split(".");
  return parts[parts.length - 1] || mod;
}

// ─── Imports ───────────────────────────────────────────────────────────────

const DIRECTIVE_RE = /^\s*(import|alias|use|require)\s+([A-Z][\w.]*)(.*)$/;

/**
 * `import`/`alias`/`use`/`require` lines as imports of the module they name,
 * with the name the file then calls it by: the last segment (`alias
 * MyApp.Accounts.User` → `User`), the `as:` name, or each member of a
 * multi-alias (`alias MyApp.Accounts.{User, Token}` — over several lines too).
 */
export function extractElixirImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const push = (source: string, name: string, line: number): void => {
    out.push({ source, specifiers: [name], isDefault: false, isNamespace: false, isType: false, line });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_RE.exec(lines[i] ?? "");
    if (!m) continue;
    const [, kind, mod, rest] = m;
    if (kind === "alias" && mod!.endsWith(".") && rest!.trimStart().startsWith("{")) {
      const uncommented = (line: string): string => line.replace(/#.*$/, "");
      let text = uncommented(rest!);
      let j = i;
      while (!text.includes("}") && j + 1 < lines.length && j - i < 50) text += " " + uncommented(lines[++j] ?? "");
      const inner = text.slice(text.indexOf("{") + 1, text.indexOf("}") >= 0 ? text.indexOf("}") : undefined);
      for (const item of inner.split(",")) {
        const member = item.trim();
        if (/^[A-Z][\w.]*$/.test(member)) push(mod! + member, lastSeg(member), i + 1);
      }
      continue;
    }
    const as = kind === "alias" ? /,\s*as:\s*([A-Z]\w*)/.exec(rest!) : null;
    push(mod!, as ? as[1]! : lastSeg(mod!), i + 1);
  }
  return out;
}

// ─── Ecto data access ──────────────────────────────────────────────────────

const ECTO_REPO_RE = /\bRepo\.(all|get|get!|get_by|get_by!|one|one!|exists\?|aggregate|delete_all|update_all|preload)\s*\(\s*([A-Z][\w.]*)/g;
const ECTO_FROM_RE = /\bfrom\s*\(\s*\w+\s+in\s+([A-Z][\w.]*)/g;

/**
 * Ecto reads through `Repo.<verb>(Schema, …)` and `from(x in Schema, …)`. The
 * entity is the queried schema module's last segment (`MyApp.Accounts.User` →
 * `User`). Mutations (`insert`/`update`/`delete`) take changesets, not the
 * schema, so their table is unknowable here and they're intentionally skipped.
 */
function extractElixirDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const ln = i + 1;
    for (const m of line.matchAll(ECTO_REPO_RE)) {
      const entity = lastSeg(m[2]);
      out.push({ kind: "database", name: `Repo.${m[1]}`, target: entity, calls: [], line: ln, entity });
    }
    for (const m of line.matchAll(ECTO_FROM_RE)) {
      const entity = lastSeg(m[1]);
      out.push({ kind: "database", name: `from(${m[1]})`, target: entity, calls: [], line: ln, entity });
    }
  }
  return out;
}

/**
 * Elixir regex spec. Modules (`defmodule`) map to the class concept; `def`/
 * `defp`/`defmacro` are functions (lowercase atoms, may end in `?`/`!`); blocks
 * are indent-delimited (`do … end`, conventionally 2-space indented).
 */
export const elixirSpec: RegexLangSpec = {
  language: "elixir",
  extensions: [".ex", ".exs"],
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      // `def foo(...)`, `defp bar do`, `defmacro baz`. `defmodule` is excluded
      // (no whitespace after `def`). Private = defp/defmacrop.
      pattern: /^\s*(?:def|defp|defmacro|defmacrop)\s+([a-z_][\w?!]*)/,
      isExported: (line) => /^\s*(?:def|defmacro)\s/.test(line),
    },
  ],

  classPatterns: [
    { pattern: /^\s*defmodule\s+([A-Z][\w.]*)/ },
    { pattern: /^\s*defprotocol\s+([A-Z][\w.]*)/ },
  ],

  // Multi-aliases and `as:` need more than one line or one specifier.
  extractImports: (lines) => extractElixirImports(lines),

  importPatterns: [
    {
      // `import`/`alias`/`use`/`require Some.Module`
      pattern: /^\s*(?:import|alias|use|require)\s+([A-Z][\w.]*)/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split(".");
        return [parts[parts.length - 1]];
      },
    },
  ],

  /**
   * `def show(conn, %{"id" => id})` — the second argument is a map pattern
   * whose keys are the request; the generic splitter hands it over in pieces
   * (`=>` reads as a bracket to it). Keep the map only under its `= name`
   * binding and drop the fragments; `attachPatternKeys` reads the keys from
   * the head line itself. `opts \\ []` keeps its name.
   */
  parseParam: (p) => {
    const t = p.trim();
    if (!t) return null;
    // `%{…} = params` binds the whole map; the splitter may hand the `= params`
    // tail over on a later fragment, so look for it on any piece. An unnamed
    // pattern has no name to bind — its keys are the parameters.
    const bound = t.match(/\}\s*=\s*([a-z_]\w*)\s*$/);
    if (bound) return { name: bound[1]!, type: null, defaultValue: null };
    if (t.startsWith("%") || /^["'\[{]|=>|^\w+\}$/.test(t)) return null;
    const m = t.match(/^([a-z_]\w*[?!]?)\s*(?:\\\\\s*(.+))?$/);
    return m ? { name: m[1]!, type: null, defaultValue: m[2]?.trim() ?? null } : null;
  },

  /**
   * Every Elixir `def` sits in a `defmodule`, so the generic pass already lists
   * each one as a method; overriding `extractClasses` makes the core drop the
   * top-level duplicate (it does so for any spec that provides the hook), which
   * is what lets the project-level handler join find `show` once, not twice.
   */
  extractClasses: (lines) => extractClassesWithSpec(lines, elixirSpec),

  /** `conn.body_params["x"]`, `get_req_header(conn, "x")`, `cast(attrs, [...])` — see `phoenix.ts`. */
  extractRequestAccess: (bodyLines) => extractElixirRequestAccess(bodyLines),

  /** Ecto `schema` fields → properties; action-head pattern keys → `requestAccess`. */
  postProcessClasses: (lines, classes) => {
    for (const cls of classes) {
      attachEctoSchema(lines, cls);
      attachPatternKeys(lines, cls.methods);
    }
    return classes;
  },

  extractRoutes: (lines) => extractPhoenixRoutes(lines),
  extractDataSources: (lines) => extractElixirDataSources(lines),
  /** Ecto `belongs_to` / `has_many` / `has_one` / `many_to_many` → entity relations (see `phoenix.ts`). */
  extractEntityRelations: (lines, classes, imports) => extractEctoRelations(lines, classes, imports),
};
