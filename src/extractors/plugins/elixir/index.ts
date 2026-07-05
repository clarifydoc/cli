import type { RegexLangSpec } from "../shared/regex-base.js";
import type { RouteInfo, DataSourceInfo } from "../../../types/analysis.js";

/** Last dotted segment of an Elixir module alias (`MyApp.Accounts.User` → `User`). */
function lastSeg(mod: string): string {
  const parts = mod.split(".");
  return parts[parts.length - 1] || mod;
}

// ─── Phoenix routes ────────────────────────────────────────────────────────

const PHX_SCOPE_RE = /^\s*scope\s+"([^"]+)"/;
const PHX_ROUTE_RE = /^\s*(get|post|put|patch|delete|head|options)\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)\s*,\s*:([a-z_]\w*)/;
const PHX_RESOURCES_RE = /^\s*resources\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)/;
const PHX_LIVE_RE = /^\s*live\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)/;

/**
 * Phoenix router macros (`get "/users", UserController, :index`), with a simple
 * `scope "/prefix" do … end` prefix stack. The stack is approximate (Elixir's
 * shared `end` keyword means a non-scope block close can mis-pop), but routers
 * are overwhelmingly nested scopes, so it holds for the common case.
 */
function extractElixirRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const scopeStack: string[] = [];
  const join = (p: string) => ((scopeStack.join("") + p).replace(/\/{2,}/g, "/") || "/");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const ln = i + 1;

    const scope = line.match(PHX_SCOPE_RE);
    if (scope && /\bdo\b/.test(line)) { scopeStack.push(scope[1]); continue; }
    if (/^end\b/.test(trimmed) && scopeStack.length) { scopeStack.pop(); continue; }

    const r = line.match(PHX_ROUTE_RE);
    if (r) {
      routes.push({ path: join(r[2]), httpMethod: r[1].toUpperCase(), kind: "api", handler: `${r[3]}.${r[4]}`, calls: [], middleware: [], line: ln });
      continue;
    }
    const res = line.match(PHX_RESOURCES_RE);
    if (res) {
      routes.push({ path: join(res[1]), httpMethod: null, kind: "api", handler: res[2], calls: [], middleware: [], line: ln });
      continue;
    }
    const live = line.match(PHX_LIVE_RE);
    if (live) {
      routes.push({ path: join(live[1]), httpMethod: null, kind: "frontend", handler: live[2], calls: [], middleware: [], line: ln });
    }
  }
  return routes;
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

  extractRoutes: (lines) => extractElixirRoutes(lines),
  extractDataSources: (lines) => extractElixirDataSources(lines),
};
