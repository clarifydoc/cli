import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { splitTopLevel } from "../../../shared/split-top-level.js";
import { blankStringAwareComments, matchingBracket } from "../../shared/text-scan.js";
import { inferFileBasedRoute } from "./file-routes.js";

/**
 * How a page is rendered — `ssr` (per request), `ssg` (at build), `isr` (at build and again on a timer
 * or on demand) or `csr` (a shell the browser fills) — read from what the framework itself reads, and
 * stated only where that evidence is written:
 *
 *  - Next.js pages router: `getServerSideProps` / `getInitialProps` → ssr; `getStaticProps` → ssg, with a
 *    `revalidate` in its result → isr; none of them → csr (the page is static HTML whose data the client
 *    fetches). A page that re-exports from another module without naming the data functions says nothing.
 *  - Next.js app router: the segment config a `page` or an enclosing `layout` exports — `dynamic =
 *    'force-dynamic'` → ssr, `'force-static'` / `'error'` → ssg, `revalidate = N` → isr (`0` → ssr, `false`
 *    → ssg), `generateStaticParams` → ssg. A `'use client'` component is no page mode; a page without
 *    config says nothing (the framework decides by what the page reads at run time).
 *  - SvelteKit: `export const ssr | csr | prerender` of `+page(.server).ts` and of the `+layout(.server).ts`
 *    files above it (the page's own wins) — `ssr = false` → csr, else `prerender = true` → ssg, `ssr = true`
 *    → ssr, each option inherited on its own; only a literal counts.
 *  - Nuxt: `routeRules` of `nuxt.config` (and a page's own `defineRouteRules`) — `prerender` → ssg,
 *    `isr` / `swr` → isr, `ssr: false` → csr, `ssr: true` → ssr — and the config's top-level `ssr: false`
 *    for every page without a rule of its own.
 *
 * Per file the extractor states a `render-mode` fact only when it finds one of those spellings; the
 * resolver joins the facts to the page routes (`RouteInfo.renderMode`).
 */
const RENDER_MODE = "render-mode";

type RenderMode = NonNullable<RouteInfo["renderMode"]>;

/** The segment config of a Next app-router `page` / `layout`. */
interface NextOptions {
  dynamic?: "force-dynamic" | "force-static" | "error";
  /** A number of seconds (0 = every request) or `false` (never). */
  revalidate?: number | false;
  staticParams?: true;
}

/** The page options of a SvelteKit `+page` / `+layout` module. */
interface SvelteOptions {
  ssr?: boolean;
  prerender?: boolean;
}

/** One `render-mode` fact: the file's role and what it states. */
type RenderFact =
  | { fw: "next-pages"; mode: RenderMode }
  /** `pages/_app`: whether it defines `getInitialProps` (every page then renders per request); null when it hides its exports. */
  | { fw: "next-shell"; initialProps: boolean | null }
  | { fw: "next-app"; role: "page" | "layout"; opts: NextOptions }
  | { fw: "sveltekit"; role: "page" | "layout"; opts: SvelteOptions }
  | { fw: "nuxt-page"; mode: RenderMode }
  | { fw: "nuxt-config"; ssr?: false; rules: Array<{ pattern: string; rule: NuxtRule }> };

interface NuxtRule {
  ssr?: boolean;
  prerender?: boolean;
  isr?: boolean;
}

/** The body (without braces) of the object literal opening at `open`, or null. */
function objectBody(text: string, open: number): string | null {
  const end = text[open] === "{" ? matchingBracket(text, open, { quotes: "\"'`" }) : -1;
  return end < 0 ? null : text.slice(open + 1, end);
}

/** The top-level `key: value` entries of an object body, key quoted or bare. */
function entriesOf(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const piece of splitTopLevel(body, { trim: true, dropBlank: true })) {
    const m = /^(?:(['"`])([^'"`]*)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(piece);
    if (m) out.push({ key: m[2] ?? m[3]!, value: m[4]!.trim() });
  }
  return out;
}

function literal(value: string): boolean | number | string | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const s = /^(['"`])([^'"`$]*)\1$/.exec(value);
  return s ? s[2]! : undefined;
}

// ---- Next.js -------------------------------------------------------------------------------------------

/** Whether `name` is exported by the file, written as a declaration or an export list entry. */
function exportsName(text: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  return (
    new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\s*\\*?|const|let|var)\\s+${n}\\b`).test(text) ||
    new RegExp(`\\bexport\\s*\\{[^}]*(?:\\bas\\s+${n}\\b|(?<![\\w$.])${n}(?![\\w$]))[^}]*\\}`).test(text)
  );
}

/** Whether the file forwards exports it does not show (`export * from`, `export { default } from`). */
function forwardsUnknownExports(text: string): boolean {
  return /\bexport\s*\*\s*from\b/.test(text) || /\bexport\s*\{[^}]*\}\s*from\b/.test(text);
}

const GET_INITIAL_PROPS = /\.getInitialProps\s*=|\bstatic\s+(?:async\s+)?getInitialProps\b/;

/** A pages-router page's mode, or null when the file hides what it exports. */
function nextPagesMode(text: string): RenderMode | null {
  if (exportsName(text, "getServerSideProps") || GET_INITIAL_PROPS.test(text)) return "ssr";
  if (exportsName(text, "getStaticProps")) {
    // `revalidate` in what getStaticProps returns (a number or a variable), not elsewhere in the file.
    const decl = /\bexport\s+(?:async\s+)?(?:function\s+getStaticProps\b|(?:const|let|var)\s+getStaticProps\b)/.exec(text);
    // Up to the next top-level export: a helper further down is not what getStaticProps returns.
    const from = decl ? decl.index + decl[0].length : 0;
    const next = text.slice(from).search(/^export\b/m);
    const rest = text.slice(from, next < 0 ? text.length : from + next);
    const rev = /\brevalidate\s*:\s*([\w$.]+)/.exec(rest)?.[1];
    if (rev === "0") return null;
    return rev && rev !== "false" ? "isr" : "ssg";
  }
  return forwardsUnknownExports(text) ? null : "csr";
}

/** The segment config a Next app-router `page` / `layout` exports; empty when none is a literal. */
function nextSegmentConfig(text: string): NextOptions {
  const opts: NextOptions = {};
  const dyn = /\bexport\s+const\s+dynamic\s*(?::[^=]+)?=\s*(['"`])(force-dynamic|force-static|error|auto)\1/.exec(text);
  if (dyn && dyn[2] !== "auto") opts.dynamic = dyn[2] as NextOptions["dynamic"];
  const rev = /\bexport\s+const\s+revalidate\s*(?::[^=]+)?=\s*(false|\d+)\b/.exec(text);
  if (rev) opts.revalidate = rev[1] === "false" ? false : Number(rev[1]);
  if (exportsName(text, "generateStaticParams")) opts.staticParams = true;
  return opts;
}

/** The mode a Next app-router config states, or null. */
function nextAppMode(o: NextOptions): RenderMode | null {
  if (o.dynamic === "force-dynamic") return "ssr";
  const timed = typeof o.revalidate === "number" && o.revalidate > 0;
  // A static page that also revalidates is incremental; `revalidate = 0` makes a page that states no static mode dynamic.
  if (o.dynamic === "force-static" || o.dynamic === "error" || o.staticParams === true) return timed ? "isr" : o.revalidate === 0 && o.dynamic === undefined ? "ssr" : "ssg";
  if (timed) return "isr";
  if (o.revalidate === 0) return "ssr";
  return o.revalidate === false ? "ssg" : null;
}

// ---- SvelteKit -----------------------------------------------------------------------------------------

function svelteOptions(text: string): SvelteOptions {
  const opts: SvelteOptions = {};
  for (const m of text.matchAll(/\bexport\s+const\s+(ssr|csr|prerender)\s*(?::[^=]+)?=\s*(true|false)\b/g)) {
    const v = m[2] === "true";
    if (m[1] === "ssr") opts.ssr = v;
    else if (m[1] === "prerender") opts.prerender = v;
  }
  return opts;
}

/** The mode of merged SvelteKit options, or null. */
function svelteMode(o: SvelteOptions): RenderMode | null {
  // A page that does not render on the server is a shell the browser fills, prerendered or not.
  if (o.ssr === false) return "csr";
  if (o.prerender === true) return "ssg";
  if (o.ssr === true) return "ssr";
  return null;
}

// ---- Nuxt ----------------------------------------------------------------------------------------------

/** A rule object (`{ prerender: true, isr: 3600 }`) as its readable keys. */
function nuxtRule(value: string): NuxtRule {
  const body = objectBody(value, 0);
  const rule: NuxtRule = {};
  if (body === null) return rule;
  for (const { key, value: v } of entriesOf(body)) {
    const lit = literal(v);
    if (key === "ssr" && typeof lit === "boolean") rule.ssr = lit;
    else if (key === "prerender" && typeof lit === "boolean") rule.prerender = lit;
    else if ((key === "isr" || key === "swr") && (lit === true || (typeof lit === "number" && lit > 0))) rule.isr = true;
    else if ((key === "isr" || key === "swr") && (lit === false || lit === 0)) rule.isr = false;
  }
  return rule;
}

function nuxtRuleMode(r: NuxtRule): RenderMode | null {
  if (r.prerender === true) return "ssg";
  if (r.isr === true) return "isr";
  if (r.ssr === false) return "csr";
  if (r.ssr === true) return "ssr";
  return null;
}

const NUXT_CONFIG = /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/;

/** Whether a Nitro pattern (`/blog/**`, `/blog/*`, `/about`) covers a page route (`/blog/:id`). */
function patternCovers(pattern: string, path: string): boolean {
  const p = pattern.replace(/\/+$/, "") || "/";
  const route = path.replace(/\/+$/, "") || "/";
  if (p === "/**") return true;
  if (p.endsWith("/**")) {
    const base = p.slice(0, -3);
    return route === base || route.startsWith(`${base}/`);
  }
  if (p.endsWith("/*")) {
    const base = p.slice(0, -2);
    return route.startsWith(`${base}/`) && !route.slice(base.length + 1).includes("/");
  }
  // An exact pattern names the route as the router spells it (`/blog/:id`), never a parameter's value.
  return p === route;
}

/** How specific a pattern is: longer literal text first, a wildcard last. */
function specificity(pattern: string): number {
  return pattern.replace(/\*+/g, "").length;
}

function nuxtConfigFact(text: string): RenderFact | null {
  const call = /\bdefineNuxtConfig\s*\(\s*\{|\bexport\s+default\s*\{/.exec(text);
  if (!call) return null;
  const body = objectBody(text, call.index + call[0].length - 1);
  if (body === null) return null;
  const top = entriesOf(body);
  const fact: Extract<RenderFact, { fw: "nuxt-config" }> = { fw: "nuxt-config", rules: [] };
  if (top.some((e) => e.key === "ssr" && e.value === "false")) fact.ssr = false;
  for (const e of top) {
    if (e.key !== "routeRules") continue;
    const rulesBody = objectBody(e.value, 0);
    if (rulesBody === null) continue;
    for (const { key, value } of entriesOf(rulesBody)) {
      const rule = nuxtRule(value);
      if (Object.keys(rule).length > 0 && key.startsWith("/")) fact.rules.push({ pattern: key, rule });
    }
  }
  return fact.ssr === undefined && fact.rules.length === 0 ? null : fact;
}

/** `defineRouteRules({ … })` in a Nuxt page: that page's own rule. */
function nuxtPageMode(text: string): RenderMode | null {
  const m = /\bdefineRouteRules\s*\(\s*\{/.exec(text);
  if (!m) return null;
  return nuxtRuleMode(nuxtRule(`{${objectBody(text, m.index + m[0].length - 1) ?? ""}}`));
}

// ---- The fact ------------------------------------------------------------------------------------------

const SVELTE_OPTION_FILE = /(?:^|\/)(?:src\/)?routes\/(?:.*\/)?\+(page|layout)(?:\.server)?\.[jt]s$/;
const NEXT_APP_FILE = /^(?:src\/)?app\/(?:.*\/)?(page|layout)\.(?:tsx?|jsx?)$/;

/**
 * The `render-mode` fact of a file that states one: a Next page, a Next app-router `page` / `layout` with segment
 * config, a SvelteKit `+page` / `+layout` module with options, a Nuxt page with `defineRouteRules`, a `nuxt.config`
 * with `routeRules` or `ssr: false`. `rawSource` is the whole file (a Vue page's `<script>` alone is `sourceText`).
 */
export function inferRenderModeFacts(relativePath: string, sourceText: string, rawSource: string, frameworkIds: string[]): RouteFact[] {
  const rel = relativePath.replace(/\\/g, "/");
  let data: RenderFact | null = null;
  // Only a pages-router file or an app-router `page`/`layout` can state a Next mode: the path decides before the text is read.
  const nextApp = NEXT_APP_FILE.exec(rel);
  if (frameworkIds.includes("nextjs") && (nextApp || /^(?:src\/)?pages\//.test(rel))) {
    const text = blankStringAwareComments(sourceText);
    const route = inferFileBasedRoute(rel, ["nextjs"]);
    if (/^(?:src\/)?pages\/_app\.(?:tsx?|jsx?)$/.test(rel)) {
      const has = GET_INITIAL_PROPS.test(text);
      data = { fw: "next-shell", initialProps: has ? true : forwardsUnknownExports(text) ? null : false };
    } else if (route?.kind === "frontend" && /^(?:src\/)?pages\//.test(rel)) {
      const mode = nextPagesMode(text);
      if (mode) data = { fw: "next-pages", mode };
    } else {
      const app = nextApp;
      // A page must be a routed one (not under `_private` or an interception folder); a layout configures what it wraps.
      if (app && (app[1] === "layout" || route?.kind === "frontend")) {
        const opts = nextSegmentConfig(text);
        if (Object.keys(opts).length > 0) data = { fw: "next-app", role: app[1] as "page" | "layout", opts };
      }
    }
  }
  if (!data && frameworkIds.includes("sveltekit")) {
    const m = SVELTE_OPTION_FILE.exec(rel);
    if (m) {
      const opts = svelteOptions(blankStringAwareComments(sourceText));
      if (Object.keys(opts).length > 0) data = { fw: "sveltekit", role: m[1] as "page" | "layout", opts };
    }
  }
  if (!data && frameworkIds.includes("nuxt")) {
    if (NUXT_CONFIG.test(rel)) data = nuxtConfigFact(blankStringAwareComments(sourceText));
    else if (inferFileBasedRoute(rel, ["nuxt"])?.kind === "frontend") {
      const mode = nuxtPageMode(blankStringAwareComments(rawSource));
      if (mode) data = { fw: "nuxt-page", mode };
    }
  }
  return data ? [{ kind: RENDER_MODE, line: 1, data }] : [];
}

// ---- The resolver --------------------------------------------------------------------------------------

function dirOf(file: string): string {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
}

function baseOf(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Gives each page route of a Next, SvelteKit or Nuxt page the mode its facts state. */
export const renderModeResolver: RouteResolver = {
  id: "render-mode",
  languages: ["typescript", "javascript"],
  priority: 27,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const facts = new Map<string, RenderFact>();
    const configs: Array<{ project: string | undefined; fact: Extract<RenderFact, { fw: "nuxt-config" }> }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== RENDER_MODE) continue;
        const data = f.data as RenderFact;
        facts.set(a.filePath, data);
        if (data.fw === "nuxt-config") configs.push({ project: a.projectId, fact: data });
      }
    }
    if (facts.size === 0) return;
    const rootOf = (a: FileAnalysis) => (a.projectId ? (ctx.projectRootOf?.(a.projectId) ?? "") : "").replace(/\/+$/, "");
    const relOf = (a: FileAnalysis) => {
      const root = rootOf(a);
      return root && a.filePath.startsWith(`${root}/`) ? a.filePath.slice(root.length + 1) : a.filePath;
    };

    for (const a of analyses) {
      const pageRoutes = a.routes.filter((r) => r.kind === "frontend");
      if (pageRoutes.length === 0) continue;
      const mode = pageMode(a, relOf(a), facts, configs);
      if (!mode) continue;
      // A route is replaced, never mutated, and only a stated mode adds the field.
      a.routes = a.routes.map((r) => {
        const m = r.kind === "frontend" && r.renderMode === undefined ? mode(r) : null;
        return m ? { ...r, renderMode: m } : r;
      });
    }
  },
};

/**
 * The facts of the files up a folder chain, deepest folder first: in each folder every stem in order, each tried
 * with every extension in order. `rel` is the page's path below its project root; the chain stops above folder
 * depth `floor`. `stemsAt(own)` says which stems count in the page's own folder (`own`) and in those above it.
 */
function* layoutChain(
  facts: Map<string, RenderFact>,
  fileRoot: string,
  rel: string,
  floor: number,
  stemsAt: (own: boolean) => string[],
  extensions: string[],
): Generator<RenderFact> {
  const dir = dirOf(rel);
  const segs = dir ? dir.split("/") : [];
  for (let n = segs.length; n > floor; n--) {
    const folder = `${fileRoot}${segs.slice(0, n).join("/")}`;
    for (const stem of stemsAt(n === segs.length)) {
      for (const ext of extensions) {
        const f = facts.get(`${folder}/${stem}.${ext}`);
        if (f) yield f;
      }
    }
  }
}

const NEXT_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const SVELTE_EXTENSIONS = ["ts", "js"];

/** The mode of the page file's routes, as a function of the route (a Nuxt rule matches on the path), or null. */
function pageMode(
  a: FileAnalysis,
  rel: string,
  facts: Map<string, RenderFact>,
  configs: Array<{ project: string | undefined; fact: Extract<RenderFact, { fw: "nuxt-config" }> }>,
): ((r: RouteInfo) => RenderMode | null) | null {
  const own = facts.get(a.filePath);
  const fileRoot = a.filePath.slice(0, a.filePath.length - rel.length);
  // A pages-router page states its mode (`csr` included) whenever it states anything; no fact, no mode.
  if (own?.fw === "next-pages") {
    if (own.mode !== "csr") return () => own.mode;
    // No data function: client-fetched, unless `_app` fetches initial props for every page (or hides what it does).
    const dir = rel.startsWith("src/") ? "src/pages" : "pages";
    let shell: boolean | null = false;
    for (const ext of NEXT_EXTENSIONS) {
      const f = facts.get(`${fileRoot}${dir}/_app.${ext}`);
      if (f?.fw === "next-shell") shell = f.initialProps;
    }
    return shell === null ? null : () => (shell ? "ssr" : "csr");
  }
  if (NEXT_APP_FILE.exec(rel)?.[1] === "page") {
    // The page's own config wins; a key it leaves out comes from the nearest layout above that states it.
    const merged: NextOptions = { ...(own?.fw === "next-app" ? own.opts : {}) };
    for (const f of layoutChain(facts, fileRoot, rel, 0, () => ["layout"], NEXT_EXTENSIONS)) {
      if (f.fw !== "next-app") continue;
      merged.dynamic ??= f.opts.dynamic;
      merged.revalidate ??= f.opts.revalidate;
    }
    const mode = nextAppMode(merged);
    return mode ? () => mode : null;
  }
  if (inferFileBasedRoute(rel, ["nuxt"])?.kind === "frontend") {
    const cfgs = configs.filter((c) => c.project === a.projectId);
    return (r) => {
      if (own?.fw === "nuxt-page") return own.mode;
      const rule: NuxtRule = {};
      let ssr: boolean | undefined;
      for (const c of cfgs) {
        if (c.fact.ssr === false) ssr = false;
        const hits = c.fact.rules.filter((x) => patternCovers(x.pattern, r.path)).sort((x, y) => specificity(x.pattern) - specificity(y.pattern));
        for (const h of hits) Object.assign(rule, h.rule);
      }
      if (rule.ssr === undefined && ssr === false) rule.ssr = false;
      return nuxtRuleMode(rule);
    };
  }
  const segs = dirOf(rel).split("/");
  // The routes folder is `routes/` or `src/routes/` at the project's root.
  const rootAt = segs[0] === "routes" ? 0 : segs[0] === "src" && segs[1] === "routes" ? 1 : -1;
  if (baseOf(rel) === "+page.svelte" && rootAt >= 0) {
    const merged: SvelteOptions = {};
    // The page's own modules first (universal before server), then each layout up to the routes folder.
    const stemsAt = (own: boolean) => (own ? ["+page", "+page.server", "+layout", "+layout.server"] : ["+layout", "+layout.server"]);
    for (const f of layoutChain(facts, fileRoot, rel, rootAt, stemsAt, SVELTE_EXTENSIONS)) {
      if (f.fw !== "sveltekit") continue;
      merged.ssr ??= f.opts.ssr;
      merged.prerender ??= f.opts.prerender;
    }
    const mode = svelteMode(merged);
    return mode ? () => mode : null;
  }
  return null;
}
