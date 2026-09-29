import type { FunctionInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta, boundParam, pathParamNames } from "../../shared/route-metadata.js";

/**
 * Perl web frameworks — Catalyst (attribute-dispatched subs), Mojolicious
 * (`$r->get(...)->to(...)` and the Lite `get '/x' => sub {}` form) and Dancer
 * (`get '/x' => sub {}`). Each fills the same route attribute layer: the
 * request values a handler reads (`params`), the checks that guard it
 * (`auth` / `middleware`), and — for Catalyst `:Args(n)` — the positional
 * path arguments as route params named after the `@_` unpack.
 */

// ─── Shared: request access ──────────────────────────────────────────────────

const REQ = String.raw`\$c\s*->\s*(?:req|request)\s*->\s*`;
const BODY_SRC = /body_parameters|body_params|body_data|data\b/;
const QUERY_SRC = /query_parameters|query_params|parameters|params\b/;

/** Cut a trailing `# comment` — outside quotes, and not the `$#` / `\#` spellings. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#" && line[i - 1] !== "$" && line[i - 1] !== "\\") return line.slice(0, i);
  }
  return line;
}

/**
 * What a Catalyst action reads from `$c->request`: `body_parameters` /
 * `body_data` / `data` → body, `params` / `query_parameters` / `param('q')`
 * → query, `header('X')` → header, `upload('f')` → form. A `my $p = $c->req->
 * body_parameters` binds `$p`, so a later `$p->{name}` is a body field.
 * `$c->req->params` is the merged query+body hash — reported as query.
 */
export function extractCatalystRequestAccess(bodyLines: string[]): RouteParamInfo[] {
  const text = bodyLines.map(stripComment).join("\n");
  if (!/\$c\s*->\s*(?:req|request)\b/.test(text)) return [];
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, binding: RouteParamBinding): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding });
  };
  const vars = new Map<string, RouteParamBinding>();
  let sawBody = false;

  // my $params = decode_json($c->request->body_data || '{}');  /  my $q = $c->req->params;
  for (const m of text.matchAll(new RegExp(String.raw`my\s+\$(\w+)\s*=[^;\n]*?${REQ}(\w+)`, "g"))) {
    const src = m[2]!;
    if (BODY_SRC.test(src)) { vars.set(m[1]!, "body"); sawBody = true; }
    else if (QUERY_SRC.test(src)) vars.set(m[1]!, "query");
  }
  // Direct: $c->req->body_params->{name} / ->param('q') / ->params->{q} / ->header('X')
  for (const m of text.matchAll(new RegExp(String.raw`${REQ}(\w+)\s*(?:->\s*\{\s*['"]?([\w-]+)['"]?\s*\}|\(\s*['"]([\w-]+)['"]\s*\))?`, "g"))) {
    const src = m[1]!;
    const key = m[2] ?? m[3];
    if (src === "header" || src === "headers") {
      if (key) add(key, "header");
      continue;
    }
    if (src === "param" && key) { add(key, "query"); continue; }
    if (src === "upload" || src === "uploads") { if (key) add(key, "form"); continue; }
    if (BODY_SRC.test(src)) {
      sawBody = true;
      if (key) add(key, "body");
      continue;
    }
    if (QUERY_SRC.test(src) && key) add(key, "query");
  }
  // $c->req->headers->header('X-Token')
  for (const m of text.matchAll(new RegExp(String.raw`${REQ}headers\s*->\s*header\s*\(\s*['"]([\w-]+)['"]`, "g"))) add(m[1]!, "header");
  // $params->{name}  — through a variable bound above
  for (const m of text.matchAll(/\$(\w+)\s*->\s*\{\s*['"]?([\w-]+)['"]?\s*\}/g)) {
    const binding = vars.get(m[1]!);
    if (binding) add(m[2]!, binding);
  }
  // `My::Form->new(%$params)` on a body-bound hash: the body IS that class —
  // the one static link from an untyped decode to a typed Moose shape.
  for (const m of text.matchAll(/([A-Z][\w:]*)\s*->\s*new\s*\(\s*(?:%\$|%\{\s*\$|\$)(\w+)/g)) {
    if (vars.get(m[2]!) === "body" && !out.some((p) => p.binding === "body" && p.type)) {
      out.push({ name: "body", type: m[1]!, binding: "body" });
      seen.add("body:body");
    }
  }
  // A body read whose keys are never named: report the body itself.
  if (sawBody && !out.some((p) => p.binding === "body")) add("body", "body");
  return out;
}

/** The argument text of a call whose opening paren sits just before `from`, balanced. */
function balancedArgs(line: string, from: number): string {
  let depth = 1;
  for (let i = from; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return line.slice(from, i);
  }
  return line.slice(from);
}

// ─── Shared: guards ──────────────────────────────────────────────────────────

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** String-literal role names in a `check_user_roles(...)` argument list (`'admin'`, `qw/a b/`, `['a']`). */
function rolesIn(args: string): string[] {
  const roles: string[] = [];
  const qw = args.match(/qw\s*[/(\[{]\s*([^/)\]}]*)/);
  if (qw) roles.push(...qw[1]!.trim().split(/\s+/).filter(Boolean));
  for (const m of args.matchAll(/['"]([\w-]+)['"]/g)) roles.push(m[1]!);
  // Dancer's `require_role admin =>` — a bareword role.
  const bare = args.match(/^\s*([\w-]+)\s*$/);
  if (roles.length === 0 && bare) roles.push(bare[1]!);
  return [...new Set(roles)];
}

/**
 * Access checks in a Catalyst sub body. `$c->user_exists` and
 * `$c->check_user_roles('admin')` are Catalyst::Plugin::Authentication /
 * Authorization::Roles; `$c->authenticate(...)` is the mechanism itself and
 * only counts as a guard in `auto`/`begin` (in an action it IS the login).
 */
export function catalystGuards(bodyLines: string[], opts: { inAuto: boolean }): GuardAttr[] {
  const guards: GuardAttr[] = [];
  const seen = new Set<string>();
  const push = (g: GuardAttr): void => {
    if (seen.has(g.text)) return;
    seen.add(g.text);
    guards.push(g);
  };
  for (const raw of bodyLines) {
    const line = stripComment(raw);
    let m: RegExpMatchArray | null;
    if (/\$c\s*->\s*user_exists\b/.test(line)) push({ text: "$c->user_exists", policies: ["user_exists"] });
    if ((m = line.match(/\$c\s*->\s*(check_user_roles|check_any_user_role|assert_user_roles|assert_any_user_role)\s*\(([^)]*)\)/))) {
      const text = collapse(`$c->${m[1]}(${m[2]})`);
      push({ text, roles: rolesIn(m[2]!) });
    }
    if (opts.inAuto && /\$c\s*->\s*authenticate\s*\(/.test(line)) push({ text: "$c->authenticate", schemes: ["catalyst"], policies: ["authenticate"] });
    if (opts.inAuto && (m = line.match(/\$c\s*->\s*(?:response\s*->\s*)?(detach|forward|redirect)\s*\(/))) {
      const args = balancedArgs(line, m.index! + m[0]!.length);
      if (/login|auth/i.test(args)) push({ text: collapse(`$c->${m[1]}(${args})`), policies: [collapse(`${m[1]}(${args})`)] });
    }
  }
  return guards;
}

// ─── Catalyst ────────────────────────────────────────────────────────────────

interface CatalystAction {
  name: string;
  attrs: string;
  line: number;
  endLine: number;
  /** Variables after `$c` in `my ($self, $c, $id) = @_`. */
  argNames: string[];
}

/** Controller namespace from the package name: `App::Controller::Admin::Users` → `admin/users`; `__PACKAGE__->config(namespace => 'x')` wins. */
function controllerNamespace(lines: string[]): string {
  for (const l of lines) {
    const cfg = l.match(/namespace\s*=>\s*['"]([^'"]*)['"]/);
    if (cfg) return cfg[1]!;
  }
  for (const l of lines) {
    const pkg = l.match(/^\s*package\s+[\w:]*?::Controller::([\w:]+)/);
    if (pkg) return pkg[1]!.split("::").map((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()).join("/");
  }
  return "";
}

function joinPath(...parts: string[]): string {
  const out = "/" + parts.join("/").split("/").filter(Boolean).join("/");
  return out;
}

function findSubEnd(lines: string[], start: number): number {
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of stripComment(lines[i]!)) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") depth--;
    }
    if (started && depth <= 0) return i + 1;
  }
  return lines.length;
}

function collectActions(lines: string[]): CatalystAction[] {
  const actions: CatalystAction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const subMatch = lines[i]!.match(/^\s*sub\s+(\w+)\s*:(.+)$/);
    if (!subMatch) continue;
    let attrText = ":" + subMatch[2]!;
    for (let j = i + 1; j < Math.min(i + 5, lines.length) && !attrText.includes("{"); j++) attrText += " " + lines[j]!;
    attrText = attrText.slice(0, attrText.indexOf("{") >= 0 ? attrText.indexOf("{") : undefined);
    const endLine = findSubEnd(lines, i);
    const argNames: string[] = [];
    for (let j = i + 1; j < Math.min(i + 6, endLine); j++) {
      const unpack = lines[j]!.match(/my\s*\(\s*\$self\s*,\s*\$c\s*((?:,\s*\$\w+\s*)*)\)\s*=\s*@_/);
      if (unpack) {
        for (const v of unpack[1]!.matchAll(/\$(\w+)/g)) argNames.push(v[1]!);
        break;
      }
    }
    actions.push({ name: subMatch[1]!, attrs: attrText, line: i + 1, endLine, argNames });
  }
  return actions;
}

function argCount(attrs: string, kind: "Args" | "CaptureArgs"): number | null {
  const m = attrs.match(new RegExp(`:${kind}\\s*\\(\\s*(\\d+)\\s*\\)`));
  return m ? Number(m[1]) : null;
}

/** Route params + path suffix for `n` positional args, named from the `@_` unpack when it has them. */
function positional(n: number, argNames: string[], numberFrom = 0): { suffix: string; params: RouteParamInfo[] } {
  const params: RouteParamInfo[] = [];
  let suffix = "";
  for (let k = 0; k < n; k++) {
    const name = argNames[k] ?? `arg${numberFrom + k + 1}`;
    suffix += `/{${name}}`;
    params.push(boundParam(name, null, "route"));
  }
  return { suffix, params };
}

/**
 * Catalyst dispatch attributes → routes. `:Path('/x')` is absolute (`:Path('x')`
 * and a bare `:Path` are relative to the controller namespace), `:Local` is
 * `<namespace>/<action>`, `:Global` is `/<action>`; `:Args(n)` appends one
 * `{name}` segment per positional argument (named from `my ($self, $c, $id)
 * = @_`) and binds each to the route. A `:Chained('parent') :PathPart('x')`
 * endpoint resolves its parent within the file (`:CaptureArgs` midpoints
 * contribute their captures); a parent in another controller is unknown, so
 * the chain starts at the first part seen here. `auto`/`begin` `:Private`
 * checks are inherited by every action in the file.
 */
export function extractCatalystRoutes(lines: string[]): RouteInfo[] {
  const actions = collectActions(lines);
  if (actions.length === 0) return [];
  const ns = controllerNamespace(lines);
  const byName = new Map(actions.map((a) => [a.name, a]));

  const inherited: GuardAttr[] = [];
  for (const a of actions) {
    if (!/^(auto|begin)$/.test(a.name) && !/:Private\b/.test(a.attrs)) continue;
    if (/^(auto|begin)$/.test(a.name)) inherited.push(...catalystGuards(lines.slice(a.line, a.endLine), { inAuto: true }));
  }

  /** Path + captured params contributed by a chain up to (and including) `a`. */
  const chainPrefix = (a: CatalystAction, depth = 0): { path: string; params: RouteParamInfo[] } => {
    const parentM = a.attrs.match(/:Chained\s*\(\s*['"]?([^'")]*)['"]?\s*\)/);
    const parent = parentM ? parentM[1]!.trim() : "";
    let base: { path: string; params: RouteParamInfo[] } = { path: "", params: [] };
    if (parent && parent !== "/" && depth < 8) {
      const p = byName.get(parent.replace(/^.*\//, ""));
      if (p && p !== a) base = chainPrefix(p, depth + 1);
    }
    const partM = a.attrs.match(/:PathPart\s*\(\s*['"]([^'"]*)['"]\s*\)/);
    const part = partM ? partM[1]! : /:PathPart\b/.test(a.attrs) ? a.name : a.name;
    const captures = argCount(a.attrs, "CaptureArgs") ?? 0;
    const { suffix, params } = positional(captures, a.argNames);
    return { path: joinPath(base.path, part) + suffix, params: [...base.params, ...params] };
  };

  const routes: RouteInfo[] = [];
  for (const a of actions) {
    if (/:Private\b/.test(a.attrs) || /:ActionClass\s*\(\s*['"]?RenderView/.test(a.attrs)) continue;
    let path: string | null = null;
    let params: RouteParamInfo[] = [];
    const pathM = a.attrs.match(/:Path\s*\(\s*['"]([^'"]*)['"]\s*\)/);
    if (pathM) path = pathM[1]!.startsWith("/") ? pathM[1]! : joinPath(ns, pathM[1]!);
    else if (/:Path\b/.test(a.attrs)) path = joinPath(ns);
    else if (/:Global\b/.test(a.attrs)) path = "/" + a.name;
    else if (/:Local\b/.test(a.attrs)) path = joinPath(ns, a.name);
    else if (/:Chained\b/.test(a.attrs)) {
      if (argCount(a.attrs, "CaptureArgs") !== null) continue; // a midpoint, not an endpoint
      const chain = chainPrefix(a);
      path = chain.path;
      params = chain.params;
    }
    if (path === null) continue;

    const args = argCount(a.attrs, "Args");
    if (args !== null && args > 0) {
      const pos = positional(args, a.argNames, params.length);
      path += pos.suffix;
      params = [...params, ...pos.params];
    }
    const methodM = a.attrs.match(/:Method\s*\(\s*['"](\w+)['"]\s*\)/) ?? a.attrs.match(/:(GET|POST|PUT|PATCH|DELETE)\b/);
    const own = catalystGuards(lines.slice(a.line, a.endLine), { inAuto: false });
    for (const m of a.attrs.matchAll(/:Does\s*\(\s*['"]?([\w:]+)['"]?\s*\)/g)) {
      if (/auth|login|acl|role|permission|secure/i.test(m[1]!)) own.push({ text: `Does(${m[1]})`, policies: [m[1]!] });
    }
    const access = extractCatalystRequestAccess(lines.slice(a.line, a.endLine)).map((p) => ({ ...p, inferred: true }));
    const tokens = pathParamNames(path);
    for (const p of access) if (!params.some((q) => q.name === p.name && q.binding === p.binding)) params.push(tokens.has(p.name.toLowerCase()) ? { ...p, binding: "route" } : p);

    const route: RouteInfo = {
      path,
      httpMethod: methodM ? methodM[1]!.toUpperCase() : null,
      kind: "api",
      handler: a.name,
      calls: [],
      middleware: [],
      line: a.line,
    };
    applyRouteMeta(route, { inheritedGuards: inherited, guards: own, params });
    routes.push(route);
  }
  return routes;
}

// ─── Mojolicious / Dancer ────────────────────────────────────────────────────

const LITE_ROUTE_RE = /^(\s*)(get|post|put|patch|del|delete|any|options)\s+(['"])([^'"]+)\3\s*=>\s*(.*)$/;
const MOJO_FULL_RE = /^\s*(?:my\s+)?(?:\$(\w+)\s*=\s*)?\$(\w+)\s*->\s*(get|post|put|patch|delete|any|options|under)\s*\(\s*(?:(['"])([^'"]+)\4)?/;

export function isMojoliciousFile(lines: string[]): boolean {
  return lines.some((l) => /^\s*use\s+Mojolicious(?:::Lite)?\b/.test(l) || /^\s*use\s+Mojo::Base\s+['"]Mojolicious/.test(l));
}

export function isDancerFile(lines: string[]): boolean {
  return lines.some((l) => /^\s*use\s+Dancer2?\b/.test(l));
}

/** `users#show` / `controller => 'users', action => 'show'` → `UsersController#show`-style handler text. */
function mojoTarget(text: string): string | null {
  const short = text.match(/->\s*to\s*\(\s*['"](\w+)#(\w+)['"]/);
  if (short) return `${camel(short[1]!)}#${short[2]}`;
  const long = text.match(/->\s*to\s*\(\s*controller\s*=>\s*['"](\w+)['"]\s*,\s*action\s*=>\s*['"](\w+)['"]/);
  if (long) return `${camel(long[1]!)}#${long[2]}`;
  const named = text.match(/->\s*to\s*\(\s*['"]#?(\w+)['"]/);
  return named ? named[1]! : null;
}

function camel(s: string): string {
  return s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Block reads of a Mojolicious/Dancer handler body. */
function liteAccess(body: string, path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const tokens = pathParamNames(path);
  const add = (name: string, binding: RouteParamBinding): void => {
    const b: RouteParamBinding = tokens.has(name.toLowerCase()) ? "route" : binding;
    const key = `${b}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding: b, inferred: true });
  };
  // Mojolicious: $c->param('x') / $c->stash('id') / $c->req->json / $c->req->headers->header('X')
  for (const m of body.matchAll(/\$c\s*->\s*param\s*\(\s*['"]([\w-]+)['"]/g)) add(m[1]!, "query");
  for (const m of body.matchAll(/\$c\s*->\s*stash\s*\(\s*['"]([\w-]+)['"]\s*\)/g)) add(m[1]!, "route");
  for (const m of body.matchAll(/\$c\s*->\s*req\s*->\s*headers\s*->\s*header\s*\(\s*['"]([\w-]+)['"]/g)) add(m[1]!, "header");
  if (/\$c\s*->\s*req\s*->\s*(?:json|body|body_params)\b/.test(body)) add("body", "body");
  // Dancer: params->{x} / param('x') / query_parameters->get('x') / body_parameters->get('x') / route_parameters->get('id') / request->header('X')
  for (const m of body.matchAll(/(?<![\w$>])params\s*->\s*\{\s*['"]?([\w-]+)['"]?\s*\}/g)) add(m[1]!, "query");
  for (const m of body.matchAll(/(?<![\w$>])param\s*\(\s*['"]([\w-]+)['"]/g)) add(m[1]!, "query");
  for (const m of body.matchAll(/\b(query|body|route)_parameters\s*->\s*(?:get|get_all)\s*\(\s*['"]([\w-]+)['"]/g)) {
    add(m[2]!, m[1] === "route" ? "route" : m[1] === "body" ? "body" : "query");
  }
  for (const m of body.matchAll(/\brequest\s*->\s*header\s*\(\s*['"]([\w-]+)['"]/g)) add(m[1]!, "header");
  if (/\brequest\s*->\s*(?:body|data)\b|\bfrom_json\s*\(\s*request/.test(body)) add("body", "body");
  return out;
}

/** Access checks in a Mojolicious `under` / Dancer `hook before` body, or inline in a handler. */
function liteGuards(body: string): GuardAttr[] {
  const guards: GuardAttr[] = [];
  let m: RegExpMatchArray | null;
  if ((m = body.match(/\b(require_login|logged_in_user|require_role\s+['"]?\w+['"]?|require_any_role\s*\[[^\]]*\])/))) {
    const text = collapse(m[1]!);
    const roles = /require_(?:any_)?role/.test(text) ? rolesIn(text.replace(/^require_(?:any_)?role\s*/, "")) : [];
    guards.push(roles.length > 0 ? { text, roles } : { text, policies: [text] });
  }
  if ((m = body.match(/\b(?:redirect|render|halt|return)\b[^;\n]*\b(?:unless|if)\b[^;\n]*\b(?:session|user|logged|auth|token)[^;\n]*/))) {
    const text = collapse(m[0]!);
    guards.push({ text, policies: [text] });
  }
  if (/\bbasic_auth\b|Rack::Auth::Basic|Mojolicious::Plugin::BasicAuth/.test(body)) guards.push({ text: "basic_auth", schemes: ["basic"], policies: ["basic_auth"] });
  if ((m = body.match(/\$c\s*->\s*(?:session|signed_cookie)\s*\(\s*['"](\w+)['"]\s*\)[^;\n]*/))) {
    const text = collapse(m[0]!);
    if (!guards.some((g) => g.text.includes(text))) guards.push({ text, policies: [text] });
  }
  return guards;
}

/** Index of the `};` / `}` closing a `sub {` opened at `start`, or the file end. */
function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of stripComment(lines[i]!)) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") depth--;
    }
    if (started && depth <= 0) return i + 1;
  }
  return lines.length;
}

/**
 * Mojolicious (full and Lite) and Dancer routes. Lite/Dancer share the
 * `get '/x' => sub { … }` shape; guards come from `under sub {}` / `hook
 * before => sub {}` bodies that check a session or call `require_login`, and
 * from Dancer2::Plugin::Auth::Extensible's `require_login sub {}` /
 * `require_role admin => sub {}` wrappers on the route itself. In the full
 * Mojolicious app, `my $auth = $r->under(...)` guards every route chained on
 * `$auth`.
 */
export function extractMojoDancerRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const inherited: GuardAttr[] = [];
  const guardedVars = new Map<string, GuardAttr[]>();

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!);
    // Dancer `hook before => sub {` / Mojolicious::Lite `under sub {` / `under '/admin' => sub {`
    if (/^\s*(?:hook\s+before\s*=>\s*sub|under\s+(?:['"][^'"]*['"]\s*=>\s*)?sub)\s*\{/.test(line)) {
      const end = blockEnd(lines, i);
      inherited.push(...liteGuards(lines.slice(i + 1, end).join("\n")));
      continue;
    }
    // Full Mojolicious: my $auth = $r->under('/admin')->to('auth#check');
    const full = line.match(MOJO_FULL_RE);
    if (full) {
      const [, assignVar, recvVar, verb, , rawPath] = full;
      const parentGuards = guardedVars.get(recvVar!) ?? [];
      if (verb === "under") {
        const target = mojoTarget(line) ?? "under";
        const guard: GuardAttr = { text: `under(${rawPath ?? ""})->${target}`, policies: [target] };
        if (assignVar) guardedVars.set(assignVar, [...parentGuards, guard]);
        else inherited.push(guard);
        continue;
      }
      if (!rawPath) continue;
      const route: RouteInfo = {
        path: rawPath,
        httpMethod: verb === "any" ? null : verb!.toUpperCase(),
        kind: "api",
        handler: mojoTarget(line),
        calls: [],
        middleware: [],
        line: i + 1,
      };
      let params: RouteParamInfo[] = [];
      if (/=>\s*sub\s*\{|\)\s*=>\s*sub/.test(line) || /sub\s*\{\s*$/.test(line)) {
        const end = blockEnd(lines, i);
        params = liteAccess(lines.slice(i + 1, end).join("\n"), rawPath);
      }
      applyRouteMeta(route, { inheritedGuards: [...inherited, ...parentGuards], params });
      routes.push(route);
      continue;
    }
    // Lite / Dancer: get '/x' => sub { … };  /  get '/x' => require_login sub { … };
    const lite = line.match(LITE_ROUTE_RE);
    if (!lite) continue;
    const [, , verb, , rawPath, rest] = lite;
    const own = liteGuards(rest!);
    const end = blockEnd(lines, i);
    // A one-line route keeps its whole body on the route line, after the `=>`.
    const body = [rest!.replace(/^[^{]*\{/, ""), ...lines.slice(i + 1, end)].join("\n");
    const route: RouteInfo = {
      path: rawPath!,
      httpMethod: verb === "any" ? null : verb === "del" ? "DELETE" : verb!.toUpperCase(),
      kind: "api",
      handler: mojoTarget(rest!),
      calls: [],
      middleware: [],
      line: i + 1,
    };
    applyRouteMeta(route, { inheritedGuards: inherited, guards: [...own, ...liteGuards(body).filter((g) => !own.some((o) => o.text === g.text))], params: liteAccess(body, rawPath!) });
    routes.push(route);
  }
  return routes;
}

/** Exposed for the spec's `extractRequestAccess`: `fn` is unused (no signature to read). */
export function perlRequestAccess(bodyLines: string[], _fn: { name: string; params: FunctionInfo["params"] }): RouteParamInfo[] {
  return extractCatalystRequestAccess(bodyLines);
}
