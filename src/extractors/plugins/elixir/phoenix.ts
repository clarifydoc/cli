import type { EntityRelation } from "../../../types/analysis.js";
import type { ClassInfo, FunctionInfo, PropertyInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta } from "../../shared/route-metadata.js";

/**
 * Phoenix routers, controllers and Ecto schemas — the attribute layer of an
 * Elixir web app. The router is where auth lives (`pipeline :auth do plug …
 * end` + `pipe_through [:api, :auth]` per scope), the controller is where the
 * request is read (`def show(conn, %{"id" => id})`), and an Ecto `schema`
 * block is the only typed shape a body can have.
 */

// ─── Router ──────────────────────────────────────────────────────────────────

const PHX_SCOPE_RE = /^\s*scope\s+(?:"([^"]+)"|path:\s*"([^"]+)")/;
const PHX_PIPELINE_RE = /^\s*pipeline\s+:(\w+)\s+do\b/;
const PHX_PLUG_RE = /^\s*plug\s+(.+?)\s*$/;
const PHX_PIPE_THROUGH_RE = /^\s*pipe_through\s+(.+?)\s*$/;
const PHX_ROUTE_RE = /^\s*(get|post|put|patch|delete|head|options)\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)\s*,\s*:([a-z_]\w*)/;
const PHX_RESOURCES_RE = /^\s*resources\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)(.*)$/;
const PHX_LIVE_RE = /^\s*live\s+"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)(?:\s*,\s*:(\w+))?/;

/** A plug whose name reads as an access check rather than content negotiation or layout. */
const AUTH_PLUG_RE = /auth|guardian|pow\b|session_?(?:auth|check)|token|login|verify|require|ensure|permission|role|admin|protect_(?!from_forgery)|authorize/i;

/** Plugs that are plumbing, never guards — listed as middleware only. */
const PLUMBING_RE = /^:(?:accepts|fetch_session|fetch_live_flash|fetch_flash|put_root_layout|put_layout|protect_from_forgery|put_secure_browser_headers|fetch_current_user|assign_\w+|put_\w+|fetch_query_params)\b/;

interface Pipeline {
  guards: GuardAttr[];
  middleware: string[];
}

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** `plug Guardian.Plug.EnsureAuthenticated` / `plug :require_authenticated_user` / `plug :accepts, ["json"]` → text + what it contributes. */
function classifyPlug(plugText: string): { guard: GuardAttr | null; text: string } {
  const text = collapse(plugText);
  const name = text.split(",")[0]!.trim();
  if (PLUMBING_RE.test(name) || !AUTH_PLUG_RE.test(name)) return { guard: null, text };
  if (/^(?:Guardian|Pow|Ueberauth|Coherence|Phauxth|Bodyguard)\b/.test(name)) return { guard: { text, schemes: [name] }, text };
  return { guard: { text, policies: [name.replace(/^:/, "")] }, text };
}

/** `:api` / `[:browser, :auth]` → pipeline names. */
function pipelineNames(arg: string): string[] {
  return [...arg.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

interface ScopeFrame {
  prefix: string;
  guards: GuardAttr[];
  middleware: string[];
  /** `resources … do` nested member prefix is a scope too. */
  kind: "scope" | "resources" | "other";
}

/** Rails/Phoenix RESTful action set for `resources`. */
const RESOURCE_ACTIONS: Array<{ action: string; method: string; suffix: string; member: boolean }> = [
  { action: "index", method: "GET", suffix: "", member: false },
  { action: "new", method: "GET", suffix: "/new", member: false },
  { action: "create", method: "POST", suffix: "", member: false },
  { action: "show", method: "GET", suffix: "/:id", member: true },
  { action: "edit", method: "GET", suffix: "/:id/edit", member: true },
  { action: "update", method: "PUT", suffix: "/:id", member: true },
  { action: "delete", method: "DELETE", suffix: "/:id", member: true },
];

function actionFilter(opts: string): { only: Set<string> | null; except: Set<string>; singleton: boolean } {
  const onlyM = opts.match(/\bonly:\s*\[([^\]]*)\]/);
  const exceptM = opts.match(/\bexcept:\s*\[([^\]]*)\]/);
  return {
    only: onlyM ? new Set(pipelineNames(onlyM[1]!)) : null,
    except: new Set(exceptM ? pipelineNames(exceptM[1]!) : []),
    singleton: /\bsingleton:\s*true/.test(opts),
  };
}

/** `/users` → `user_id` for a nested resource's member prefix. */
function memberParam(path: string): string {
  const seg = path.split("/").filter(Boolean).pop() ?? "resource";
  const singular = seg.endsWith("ies") ? seg.slice(0, -3) + "y" : seg.endsWith("s") ? seg.slice(0, -1) : seg;
  return `${singular.replace(/-/g, "_")}_id`;
}

/**
 * Phoenix router macros. `pipeline :name do plug … end` blocks are read
 * first; `pipe_through` inside a scope attaches the named pipelines' guard
 * plugs to every route of that scope (and nested scopes) as inherited
 * guards, and the plumbing plugs as middleware. `resources` expands to its
 * RESTful set (`only:`/`except:`/`singleton:` honoured), with a `do` block
 * nesting children under `/:<singular>_id`. The `end` bookkeeping is
 * approximate — Elixir's shared `end` means a non-scope block can mis-pop —
 * but routers are overwhelmingly nested scopes, so it holds.
 */
export function extractPhoenixRoutes(lines: string[]): RouteInfo[] {
  const pipelines = new Map<string, Pipeline>();
  // Pass 1: pipelines (they may be declared after the scope that uses them).
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(PHX_PIPELINE_RE);
    if (!m) continue;
    const pipe: Pipeline = { guards: [], middleware: [] };
    for (let j = i + 1; j < lines.length && !/^\s*end\b/.test(lines[j]!); j++) {
      const plug = lines[j]!.match(PHX_PLUG_RE);
      if (!plug) continue;
      const { guard, text } = classifyPlug(plug[1]!);
      if (guard) pipe.guards.push(guard);
      else pipe.middleware.push(text);
    }
    pipelines.set(m[1]!, pipe);
  }

  const routes: RouteInfo[] = [];
  const stack: ScopeFrame[] = [];
  const top = (): ScopeFrame | undefined => stack[stack.length - 1];
  const prefix = (): string => stack.map((f) => f.prefix).join("");
  const join = (p: string): string => (prefix() + p).replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") || "/";
  const inheritedGuards = (): GuardAttr[] => stack.flatMap((f) => f.guards);
  const inheritedMiddleware = (): string[] => stack.flatMap((f) => f.middleware);
  const emit = (route: RouteInfo): void => {
    route.middleware.push(...inheritedMiddleware());
    applyRouteMeta(route, { inheritedGuards: inheritedGuards() });
    routes.push(route);
  };
  let inPipeline = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const ln = i + 1;

    if (PHX_PIPELINE_RE.test(line)) { inPipeline = true; continue; }
    if (/^end\b/.test(trimmed)) {
      if (inPipeline) inPipeline = false;
      else if (stack.length) stack.pop();
      continue;
    }
    if (inPipeline) continue;

    const scope = line.match(PHX_SCOPE_RE);
    if (scope && /\bdo\s*$/.test(trimmed)) {
      stack.push({ prefix: (scope[1] ?? scope[2] ?? "").replace(/\/$/, ""), guards: [], middleware: [], kind: "scope" });
      continue;
    }
    if (/^scope\b/.test(trimmed) && /\bdo\s*$/.test(trimmed)) {
      stack.push({ prefix: "", guards: [], middleware: [], kind: "scope" });
      continue;
    }
    const pipe = line.match(PHX_PIPE_THROUGH_RE);
    if (pipe) {
      const frame = top() ?? (stack.push({ prefix: "", guards: [], middleware: [], kind: "other" }), top()!);
      for (const name of pipelineNames(pipe[1]!)) {
        const p = pipelines.get(name);
        if (!p) { frame.middleware.push(`pipe_through :${name}`); continue; }
        frame.guards.push(...p.guards);
        frame.middleware.push(...p.middleware);
      }
      continue;
    }

    const r = line.match(PHX_ROUTE_RE);
    if (r) {
      emit({ path: join(r[2]!), httpMethod: r[1]!.toUpperCase(), kind: "api", handler: `${r[3]}.${r[4]}`, calls: [], middleware: [], line: ln });
      continue;
    }
    const res = line.match(PHX_RESOURCES_RE);
    if (res) {
      const [, path, controller, opts] = res;
      const { only, except, singleton } = actionFilter(opts!);
      for (const a of RESOURCE_ACTIONS) {
        if (singleton && a.action === "index") continue;
        if (only && !only.has(a.action)) continue;
        if (except.has(a.action)) continue;
        const suffix = singleton ? a.suffix.replace("/:id", "") : a.suffix;
        emit({ path: join(path! + suffix), httpMethod: a.method, kind: "api", handler: `${controller}.${a.action}`, calls: [], middleware: [], line: ln });
      }
      if (/\bdo\s*$/.test(trimmed)) {
        stack.push({ prefix: `${path}/:${memberParam(path!)}`, guards: [], middleware: [], kind: "resources" });
      }
      continue;
    }
    const live = line.match(PHX_LIVE_RE);
    if (live) {
      emit({ path: join(live[1]!), httpMethod: null, kind: "frontend", handler: live[3] ? `${live[2]}.${live[3]}` : live[2]!, calls: [], middleware: [], line: ln });
      continue;
    }
    // Any other `do` block (live_session, forward … do) — keep the pops balanced.
    if (/\bdo\s*$/.test(trimmed) && !/^(?:def|defp|defmodule|if|case|cond|for|with|fn|try|receive|quote)\b/.test(trimmed)) {
      stack.push({ prefix: "", guards: [], middleware: [], kind: "other" });
    } else if (/^(?:if|case|cond|for|with|try|receive|quote)\b.*\bdo\s*$/.test(trimmed)) {
      stack.push({ prefix: "", guards: [], middleware: [], kind: "other" });
    }
  }
  return routes;
}

// ─── Controller request access ───────────────────────────────────────────────

/** Actions whose params map is the request body under the Phoenix convention. */
const BODY_ACTIONS = new Set(["create", "update", "upsert", "import", "patch", "put", "post"]);

function bindingForKey(key: string, action: string): RouteParamBinding {
  if (key === "id" || key.endsWith("_id")) return "route";
  return BODY_ACTIONS.has(action) ? "body" : "query";
}

/**
 * Pattern-matched request keys in a controller action head:
 * `def create(conn, %{"user" => user_params})` → body `user`;
 * `def show(conn, %{"id" => id})` → route `id`; other keys are query for
 * read-shaped actions and body for `create`/`update`. The controller cannot
 * see the route template, so the binding is a convention, marked inferred by
 * the join.
 */
export function patternKeysFromHead(headText: string, action: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const args = headText.slice(headText.indexOf("(") + 1);
  for (const m of args.matchAll(/"([\w-]+)"\s*=>/g)) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: key, type: null, binding: bindingForKey(key, action) });
  }
  return out;
}

/**
 * Explicit reads in a function body: `conn.body_params["x"]` → body,
 * `conn.query_params["x"]` → query, `conn.path_params["x"]` → route,
 * `get_req_header(conn, "x")` → header; `cast(attrs, [:a, :b])` in a
 * changeset → the body keys the schema accepts.
 */
export function extractElixirRequestAccess(bodyLines: string[]): RouteParamInfo[] {
  const text = bodyLines.map((l) => l.replace(/#.*$/, "")).join("\n");
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, binding: RouteParamBinding): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding });
  };
  for (const m of text.matchAll(/\bconn\.(body_params|query_params|path_params|params)\s*\[\s*"([\w-]+)"\s*\]/g)) {
    const src = m[1]!;
    add(m[2]!, src === "body_params" ? "body" : src === "path_params" ? "route" : "query");
  }
  for (const m of text.matchAll(/\bget_req_header\s*\(\s*conn\s*,\s*"([\w-]+)"/g)) add(m[1]!, "header");
  for (const m of text.matchAll(/(?<![\w.])cast\s*\(\s*\w+\s*,\s*\[([^\]]*)\]/g)) {
    for (const k of m[1]!.matchAll(/:(\w+)/g)) add(k[1]!, "body");
  }
  return out;
}

/**
 * Attach the action-head pattern keys to each function/method by re-reading
 * its `def` line — the shared framework hands `extractRequestAccess` only the
 * body. Runs in `postProcessClasses` (every Elixir def lives in a module).
 */
export function attachPatternKeys(lines: string[], fns: FunctionInfo[]): void {
  for (const fn of fns) {
    let head = lines[fn.line - 1] ?? "";
    for (let j = fn.line; j < Math.min(fn.line + 4, lines.length) && !/\bdo\b|,\s*do:/.test(head); j++) head += " " + lines[j]!;
    if (!/%\{/.test(head)) continue;
    const keys = patternKeysFromHead(head, fn.name);
    if (keys.length === 0) continue;
    const merged = [...keys];
    const seen = new Set(merged.map((p) => `${p.binding}:${p.name}`));
    for (const acc of fn.requestAccess ?? []) {
      const key = `${acc.binding}:${acc.name}`;
      if (!seen.has(key)) { seen.add(key); merged.push(acc); }
    }
    fn.requestAccess = merged;
  }
}

// ─── Ecto schema ─────────────────────────────────────────────────────────────

const ECTO_FIELD_RE = /^\s*field\s+:(\w+)\s*(?:,\s*(\{[^}]*\}|:\w+|[A-Z][\w.]*))?/;
/** `belongs_to :team, Plausible.Teams.Team` / `has_many :goals, Goal, preload_order: …` / `many_to_many :tags, Tag, join_through: "posts_tags"`. */
const ECTO_ASSOC_RE = /^\s*(belongs_to|has_many|has_one|many_to_many)\s+:(\w+)\s*,\s*([A-Z][\w.]*)(.*)$/;
const ECTO_BELONGS_RE = /^\s*belongs_to\s+:(\w+)\s*,\s*([A-Z][\w.]*)/;
const ECTO_EMBEDS_RE = /^\s*embeds_(one|many)\s+:(\w+)\s*,\s*([A-Z][\w.]*)/;

function prop(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}

/** `field :name, :string` / `belongs_to :user, User` (→ `user_id`) / `embeds_many :items, Item` / `timestamps()`. */
export function ectoProperty(line: string): PropertyInfo[] {
  let m: RegExpMatchArray | null;
  if ((m = line.match(ECTO_FIELD_RE))) return [prop(m[1]!, m[2] ?? ":string")];
  if ((m = line.match(ECTO_BELONGS_RE))) return [prop(`${m[1]}_id`, ":id")];
  if ((m = line.match(ECTO_EMBEDS_RE))) return [prop(m[2]!, m[1] === "many" ? `{:array, ${m[3]}}` : m[3]!)];
  if (/^\s*timestamps\s*\(?\s*\)?\s*$/.test(line)) return [prop("inserted_at", ":naive_datetime"), prop("updated_at", ":naive_datetime")];
  return [];
}

/**
 * A `schema "table" do … end` / `embedded_schema do … end` block's fields as
 * class properties, plus `validate_required([:a, :b])` anywhere in the module
 * → `isRequired` on those properties. Properties are set only for modules
 * that declare a schema block, so a context or controller stays field-less.
 */
export function attachEctoSchema(lines: string[], cls: ClassInfo): void {
  let start = -1;
  let table: string | null = null;
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const m = /^\s*(?:schema\s+"([^"]+)"|embedded_schema)\s+do\b/.exec(lines[i]!);
    if (m) { start = i; table = m[1] ?? null; break; }
  }
  if (start < 0) return;
  // A module with a `schema "table"` block IS the table's model: an entity of
  // the Ecto ORM, carrying its table as Rails models do. An `embedded_schema`
  // is a value type, not a table.
  if (table && !cls.decorators.includes("entity")) cls.decorators.push("entity", "ecto", `table:${table}`);
  const properties: PropertyInfo[] = [];
  const indent = (lines[start]!.match(/^\s*/) ?? [""])[0]!.length;
  for (let i = start + 1; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if (/^\s*end\b/.test(line) && (line.match(/^\s*/) ?? [""])[0]!.length <= indent) break;
    properties.push(...ectoProperty(line));
  }
  const required = new Set<string>();
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const m = lines[i]!.match(/validate_required\s*\(?\s*\[([^\]]*)\]/);
    if (m) for (const k of m[1]!.matchAll(/:(\w+)/g)) required.add(k[1]!);
  }
  for (const p of properties) if (required.has(p.name)) p.isRequired = true;
  const seen = new Set(properties.map((p) => p.name));
  cls.properties = [...properties, ...cls.properties.filter((p) => !seen.has(p.name))];
}

/**
 * Ecto associations of every schema module in the file, as entity relations.
 * The target is written as a module — fully (`Plausible.Teams.Team`) or by an
 * alias (`Team`, after `alias Plausible.Teams.Team`) — and is resolved to the
 * full module name, which is what the entity graph names the schema by; an
 * alias the file never declares is taken as a sibling of the declaring module.
 * `many_to_many` carries its `join_through` table.
 */
export function extractEctoRelations(lines: string[], classes: ClassInfo[]): EntityRelation[] {
  const aliases = new Map<string, string>();
  for (const line of lines) {
    const m = /^\s*alias\s+([A-Z][\w.]*)(?:\s*,\s*as:\s*([A-Z]\w*))?\s*$/.exec(line);
    if (m) aliases.set(m[2] ?? m[1]!.split(".").pop()!, m[1]!);
    const multi = /^\s*alias\s+([A-Z][\w.]*)\.\{([^}]+)\}/.exec(line);
    if (multi) for (const name of multi[2]!.split(",").map((x) => x.trim()).filter(Boolean)) aliases.set(name, `${multi[1]}.${name}`);
  }
  const relations: EntityRelation[] = [];
  for (const cls of classes) {
    if (!cls.decorators.includes("ecto")) continue;
    const namespace = cls.name.includes(".") ? cls.name.slice(0, cls.name.lastIndexOf(".")) : "";
    const resolve = (written: string): string =>
      written.includes(".") ? written : aliases.get(written) ?? (namespace ? `${namespace}.${written}` : written);
    for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
      const m = ECTO_ASSOC_RE.exec(lines[i]!);
      if (!m) continue;
      const [, macro, field, target, rest] = m;
      const cardinality: EntityRelation["cardinality"] =
        macro === "belongs_to" ? "many-to-one" : macro === "has_one" ? "one-to-one" : macro === "has_many" ? "one-to-many" : "many-to-many";
      const join = /join_through:\s*"([^"]+)"/.exec(rest ?? "")?.[1];
      relations.push({
        fromEntity: cls.name,
        fromField: field!,
        toEntity: resolve(target!),
        cardinality,
        ...(macro === "belongs_to" ? { foreignKey: `${field}_id` } : {}),
        ...(join ? { joinTable: join } : {}),
        orm: "ecto",
        confidence: "EXTRACTED",
      });
    }
  }
  return relations;
}
