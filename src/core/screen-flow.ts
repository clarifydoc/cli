import type {
  ComponentLaunch,
  InteractiveElementInfo,
  RouteInfo,
  ScreenFlow,
  ScreenFlowEdge,
  ScreenFlowKind,
  ScreenFlowNode,
  ScreenInfo,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Which screen leads to which, and how — the navigation map of the app.
 *
 * Nodes are the pages (a routed screen, the main form, a window, a page a
 * server route renders) and the dialogs (what a screen opens, or a screen
 * whose form type says it is one). A client route that only redirects is a
 * `path` node, so `/` → `/dashboard` keeps its start. Edges are typed:
 *
 * - `navigate`: the screen's `navigatesTo`, resolved to the screen at that
 *   route (parameters alike), by name (`navigation.navigate("Profile")`) or by
 *   file (`<a href="clubs.html">`);
 * - `dialog`: a component launch (`componentLaunches`);
 * - `redirect`: a client route's `redirectTo`;
 * - `server-redirect`: a link, form or rendered page whose server route
 *   redirects (`RouteInfo.redirectsTo`), on to the page at that path;
 * - `submit`: a form whose request lands on a route another page is served at, or an event
 *   the page's route leads on from (`RouteInfo.leadsTo` — a Web Flow view's transitions).
 *
 * A screen is the sum of the components it uses: what a non-screen component
 * navigates to or opens counts for every page and dialog that imports it,
 * through the components between them however deep (a sidebar inside the
 * layout the `/` route renders), never through another screen and never
 * through two non-component modules in a row (`screensUsing`). What no screen uses but a
 * component rendering the router's outlet frames (a sidebar in the layout `App` mounts around
 * `<router-view>`) hangs off that component as a `shell` node, a start of the map. A launcher module's own
 * rows (`sourceSymbol` is the launcher) say what it opens, not who opens it,
 * and are skipped. Starts are the main form, the screen at `/` and a redirect from `/`.
 */
export function buildScreenFlow(input: {
  screens: readonly ScreenInfo[];
  routes: ReadonlyArray<RouteInfo & { filePath: string; projectId?: string }>;
  launches: readonly ComponentLaunch[];
  elements: ReadonlyArray<InteractiveElementInfo & { filePath: string }>;
  /** File → the files it uses: for a screen, the components its markup renders and the non-screen modules it imports. */
  componentGraph: Record<string, string[]>;
  projectOf: (file: string) => string | undefined;
  /** UI files rendering their router's outlet (the language's `routerOutlets`). */
  outlets?: ReadonlySet<string>;
}): ScreenFlow | undefined {
  const { screens, routes, launches, elements, componentGraph, projectOf } = input;
  const outlets = input.outlets ?? new Set<string>();
  if (screens.length === 0) return undefined;

  // One node id per screen: its file, or `file#Name` where a file holds several.
  const perFile = new Map<string, ScreenInfo[]>();
  for (const s of screens) (perFile.get(s.filePath) ?? perFile.set(s.filePath, []).get(s.filePath)!).push(s);
  const idOf = (s: ScreenInfo) => (perFile.get(s.filePath)!.length > 1 ? `${s.filePath}#${s.name}` : s.filePath);
  const fileNode = (file: string): string | null => {
    const list = perFile.get(file);
    return list ? idOf(list[0]!) : null;
  };

  const nodes = new Map<string, ScreenFlowNode>();
  const launchTargets = new Set(launches.map((l) => l.targetFile));
  const pageOf = (s: ScreenInfo) =>
    !!s.routePath || !!s.startup || !!s.renderedBy?.length || WINDOWISH.test(s.formType);
  const addScreen = (s: ScreenInfo): string => {
    const id = idOf(s);
    if (!nodes.has(id)) {
      const dialog = DIALOGISH.test(s.formType) || (!pageOf(s) && launchTargets.has(s.filePath));
      const projectId = projectOf(s.filePath);
      nodes.set(id, {
        id,
        name: s.caption || s.name,
        kind: dialog ? "dialog" : "page",
        ...(s.routePath ? { path: s.routePath } : {}),
        ...(projectId ? { projectId } : {}),
        ...(s.startup === "main" || (!!s.routePath && pathKey(s.routePath) === "/") ? { start: true as const } : {}),
      });
    }
    return id;
  };
  for (const s of screens) if (pageOf(s) || DIALOGISH.test(s.formType)) addScreen(s);

  // Screens by route key, name and file.
  const byKey = new Map<string, Set<ScreenInfo>>();
  // Paths as written first: a flow's states (`league.wf.club#details`) are no URLs, and a key would cut their `#`.
  const byExact = new Map<string, Set<ScreenInfo>>();
  const addKey = (p: string, s: ScreenInfo) => {
    (byExact.get(p) ?? byExact.set(p, new Set()).get(p)!).add(s);
    // `/teachers/:uuid?` answers at `/teachers` too.
    const bare = p.replace(/(?:\/(?::\w+\?|\[\[[^\]]+\]\]))+\/?$/, "") || "/";
    for (const variant of new Set([p, bare])) {
      const k = pathKey(variant);
      (byKey.get(k) ?? byKey.set(k, new Set()).get(k)!).add(s);
    }
  };
  for (const s of screens) {
    if (s.routePath) addKey(s.routePath, s);
    for (const p of s.otherRoutes ?? []) addKey(p, s);
    for (const r of s.renderedBy ?? []) addKey(r.path, s);
  }
  const byName = new Map<string, ScreenInfo[]>();
  for (const s of screens) (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)!).push(s);
  /** The one screen file among `xs` — two files answering to one target name neither. */
  const one = (xs: ScreenInfo[]): ScreenInfo | null =>
    xs.length > 0 && new Set(xs.map((x) => x.filePath)).size === 1 ? xs[0]! : null;
  /** A concrete path (`/clubs/42`) against the routes with parameters: the most literal segments win. */
  const byParams = (k: string): ScreenInfo[] => {
    const segs = k.split("/");
    let best: ScreenInfo[] = [];
    let bestLiterals = -1;
    for (const [rk, set] of byKey) {
      if (!rk.includes("{}")) continue;
      const rs = rk.split("/");
      if (rs.length !== segs.length || !rs.every((seg, i) => seg === "{}" || seg === segs[i])) continue;
      const literals = rs.filter((seg) => seg !== "{}").length;
      if (literals > bestLiterals) { best = [...set]; bestLiterals = literals; }
      else if (literals === bestLiterals) best.push(...set);
    }
    return best;
  };
  const screenAtPath = (p: string, project: string | undefined): ScreenInfo | null => {
    const k = pathKey(p);
    const hits = byExact.has(p) ? [...byExact.get(p)!] : byKey.has(k) ? [...byKey.get(k)!] : byParams(k);
    const same = hits.filter((s) => projectOf(s.filePath) === project);
    return one(same.length > 0 ? same : hits);
  };

  // Client redirects and server routes by path.
  const clientRedirects = new Map<string, Array<RouteInfo & { filePath: string; projectId?: string }>>();
  const serverRoutes = new Map<string, Array<RouteInfo & { filePath: string; projectId?: string }>>();
  for (const r of routes) {
    const k = pathKey(r.path);
    if (r.kind === "frontend" && r.redirectTo?.startsWith("/")) (clientRedirects.get(k) ?? clientRedirects.set(k, []).get(k)!).push(r);
    if (r.kind === "api") (serverRoutes.get(k) ?? serverRoutes.set(k, []).get(k)!).push(r);
  }

  const edges = new Map<string, ScreenFlowEdge>();
  const addEdge = (from: string, to: string, kind: ScreenFlowKind, via?: string) => {
    if (from === to) return;
    const key = `${from}\0${to}\0${kind}`;
    if (!edges.has(key)) edges.set(key, { from, to, kind, ...(via ? { via } : {}) });
  };

  // `path:/x` → the screen it redirects to; the path node only exists when that resolves.
  const redirectNode = (p: string, project: string | undefined): string | null => {
    const k = pathKey(p);
    const hops = clientRedirects.get(k);
    if (!hops) return null;
    const id = `path:${k}`;
    if (nodes.has(id)) return id;
    let targets = 0;
    for (const r of hops) {
      const to = screenAtPath(r.redirectTo!, r.projectId ?? project);
      if (!to) continue;
      if (!nodes.has(id)) nodes.set(id, { id, name: r.path || "/", kind: "path", path: r.path || "/", ...(r.projectId ? { projectId: r.projectId } : {}), ...(k === "/" ? { start: true as const } : {}) });
      addEdge(id, addScreen(to), "redirect", r.redirectTo);
      targets++;
    }
    return targets > 0 ? id : null;
  };
  for (const k of clientRedirects.keys()) redirectNode(k, undefined);

  // A route's own statement of where its page leads (a Web Flow view's transitions): the page posts the
  // event and the server shows the next view — a submit.
  for (const r of routes) {
    if (r.kind !== "frontend" || !r.leadsTo?.length) continue;
    const from = screenAtPath(r.path, r.projectId);
    if (!from) continue;
    for (const t of r.leadsTo) {
      const to = screenAtPath(t.path, r.projectId);
      if (to) addEdge(addScreen(from), addScreen(to), "submit", t.on ? `on ${t.on}` : t.path);
    }
  }

  /** Follow a request to a server route: the page it renders, and where it redirects. */
  const viaServer = (from: string, method: string, target: string, project: string | undefined, kind: "navigate" | "submit"): boolean => {
    const rs = (serverRoutes.get(pathKey(target)) ?? []).filter((r) => !method || !r.httpMethod || r.httpMethod === method.toUpperCase());
    const same = rs.filter((r) => r.projectId === project);
    let found = false;
    for (const r of same.length > 0 ? same : rs) {
      for (const p of r.redirectsTo ?? []) {
        const to = screenAtPath(p, r.projectId ?? project);
        if (to) {
          addEdge(from, addScreen(to), "server-redirect", `${r.httpMethod ?? method} ${r.path}`);
          found = true;
        }
      }
    }
    if (!found && kind === "submit") {
      const page = screenAtPath(target, project);
      if (page) {
        addEdge(from, addScreen(page), "submit", `${method || "GET"} ${target}`);
        found = true;
      }
    }
    return found;
  };

  const resolveTarget = (s: ScreenInfo, t: string): ScreenInfo | null => {
    const project = projectOf(s.filePath);
    if (t.startsWith("/")) return screenAtPath(t, project);
    const named = byName.get(t);
    if (named) {
      const same = named.filter((x) => projectOf(x.filePath) === project);
      return one(same.length > 0 ? same : named);
    }
    if (/\.html?$/i.test(t)) {
      const dir = s.filePath.includes("/") ? s.filePath.slice(0, s.filePath.lastIndexOf("/") + 1) : "";
      const file = normalizePath(dir + t);
      return perFile.get(file)?.[0] ?? null;
    }
    return null;
  };

  // Navigation and requests from each screen file; a non-page source is lifted.
  type Out = { to: string; kind: ScreenFlowKind; via?: string };
  const outOf = new Map<string, Out[]>();
  const push = (file: string, o: Out) => (outOf.get(file) ?? outOf.set(file, []).get(file)!).push(o);
  const sources = new Map<string, string>(); // scratch node id per file, for the server-route walk
  for (const s of screens) {
    const project = projectOf(s.filePath);
    for (const t of s.navigatesTo) {
      const to = resolveTarget(s, t);
      if (to) {
        push(s.filePath, { to: addScreen(to), kind: "navigate", via: t });
        continue;
      }
      if (!t.startsWith("/")) continue;
      const hop = redirectNode(t, project);
      if (hop) {
        push(s.filePath, { to: hop, kind: "navigate", via: t });
        continue;
      }
      const scratch = `scratch:${s.filePath}`;
      sources.set(scratch, s.filePath);
      viaServer(scratch, "GET", t, project, "navigate");
    }
    // A rendered page whose route also redirects (a sign-in check before the page).
    for (const r of s.renderedBy ?? []) {
      const scratch = `scratch:${s.filePath}`;
      sources.set(scratch, s.filePath);
      viaServer(scratch, r.method ?? "GET", r.path, project, "navigate");
    }
  }
  for (const el of elements) {
    if (!el.request?.target.startsWith("/") || (el.element === "link" && el.request.method === "GET")) continue;
    const scratch = `scratch:${el.filePath}`;
    sources.set(scratch, el.filePath);
    viaServer(scratch, el.request.method, el.request.target, projectOf(el.filePath), "submit");
  }
  // A dialog no screen describes: a node of its own, named after the file.
  const launchNode = (file: string): string => {
    if (!nodes.has(file)) {
      const projectId = projectOf(file);
      nodes.set(file, { id: file, name: file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), kind: "dialog", ...(projectId ? { projectId } : {}) });
    }
    return file;
  };
  for (const l of launches) {
    // The launcher's own module stating what it opens is no screen opening it: its callers are.
    if (l.sourceSymbol === l.launcher && !perFile.has(l.sourceFile)) continue;
    const shown = perFile.get(l.targetFile)?.[0];
    const to = shown ? addScreen(shown) : launchNode(l.targetFile);
    push(l.sourceFile, { to, kind: "dialog", via: l.launcher });
  }
  // Edges the server walk added from a scratch source move onto the file's outgoing list.
  for (const [key, e] of [...edges]) {
    const file = sources.get(e.from);
    if (!file) continue;
    edges.delete(key);
    push(file, { to: e.to, kind: e.kind, via: e.via });
  }

  // Who imports each file, for lifting a component's edges to its pages.
  const importers = new Map<string, string[]>();
  for (const [f, deps] of Object.entries(componentGraph)) for (const d of deps) (importers.get(d) ?? importers.set(d, []).get(d)!).push(f);
  /**
   * The screens (pages and dialogs) that use a file, through the UI components
   * between them — never through another screen. One module that is no
   * component may sit between two (a table's column definitions rendering its
   * row actions); two in a row (a query module importing a model that imports
   * a dialog) is code depending on code, not a screen showing it.
   */
  const screensUsing = (file: string): string[] => {
    const pages = new Set<string>();
    const isUi = (f: string) => perFile.has(f);
    // File → the fewest non-component modules in a row it was reached with.
    const best = new Map<string, number>([[file, isUi(file) ? 0 : 1]]);
    let frontier = [file];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        const run = best.get(f)!;
        for (const imp of importers.get(f) ?? []) {
          const id = fileNode(imp);
          if (id && nodes.has(id)) {
            pages.add(id);
            continue;
          }
          const r = isUi(imp) ? 0 : run + 1;
          if (r > 1 || (best.get(imp) ?? Infinity) <= r) continue;
          best.set(imp, r);
          next.push(imp);
        }
      }
      frontier = next;
    }
    return [...pages];
  };
  /**
   * The shells framing a component no screen uses: the files rendering the router's outlet it
   * sits in (itself, or the components above it), which become `shell` nodes and starts.
   */
  const shellsAbove = (file: string): string[] => {
    const found = new Set<string>();
    const seen = new Set([file]);
    let frontier = [file];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        if (outlets.has(f) && perFile.has(f)) {
          found.add(f);
          continue;
        }
        for (const imp of importers.get(f) ?? []) if (!seen.has(imp) && perFile.has(imp)) { seen.add(imp); next.push(imp); }
      }
      frontier = next;
    }
    return [...found].map((f) => {
      const s = perFile.get(f)![0]!;
      const id = idOf(s);
      if (!nodes.has(id)) {
        const projectId = projectOf(f);
        nodes.set(id, { id, name: s.caption || s.name, kind: "shell", ...(projectId ? { projectId } : {}), start: true });
      }
      return id;
    });
  };
  for (const [file, outs] of outOf) {
    const own = fileNode(file);
    let from = own && nodes.has(own) ? [own] : screensUsing(file);
    if (from.length === 0) from = shellsAbove(file);
    for (const f of from) for (const o of outs) addEdge(f, o.to, o.kind, o.via);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => byOrdinal(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => byOrdinal(a.from, b.from) || byOrdinal(a.to, b.to) || byOrdinal(a.kind, b.kind)),
  };
}

/** A desktop window: what the Screens tab lists as a page. */
const WINDOWISH = /(^|:)(Q?(Dialog|MainWindow|Wizard)|ApplicationWindow|Window)$/;
/** A form type that says the screen is a dialog. */
const DIALOGISH = /(Dialog|Modal|Popup|Sheet)$/i;

/**
 * A route path compared segment for segment, every parameter alike: `/clubs/:id/` ≡ `/clubs/{clubId}`.
 * A catch-all (`*`, `:path+`, `[...all]`) reads `**`, which no concrete path's segment matches:
 * a link to an unknown path is no link to the not-found page.
 */
export function pathKey(p: string): string {
  const k = ("/" + p.split(/[?#]/)[0]!)
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .split("/")
    .map((seg) => (/^(?:\*\*?|:\w+[+*]|\[\[?\.\.\.[^\]]*\]\]?)$/.test(seg) ? "**" : /^(?::\w+\??|\{[^}]*\}|\[[^\]]*\]|\$\w+)$/.test(seg) ? "{}" : seg))
    .join("/");
  return k || "/";
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}
