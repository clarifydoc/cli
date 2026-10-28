import { projectName } from "./markdown.js";
import type { BundleFile } from "./obsidian.js";
import type { InteractiveElement, Route, Screen, Summary } from "./types.js";
import { idFactory, mermaidLabel, plural } from "./text.js";

/**
 * A spec per screen, and the user flows through them, as Markdown files that
 * link to each other — the input for writing user stories screen by screen.
 *
 * Each screen's file says how a user gets there, what it loads, every action
 * on it (the control, the handler it runs, the API route that handler reaches,
 * the tables that route reads and writes), the components it is built from,
 * and the screens it leads to. A flow is the shortest navigation path from an
 * entry screen to a screen whose action changes data, ending in that action:
 * "Create players" is Dashboard → Players → Create Player → POST /api/players.
 * Story drafts are worded from those facts alone (the verb from the HTTP
 * method, the object from the table written, the actor from the route's
 * roles), so each one names the code it came from and none invents a reason.
 *
 * Links are relative `.md` links — they work in a code host, an editor's
 * preview and Obsidian alike.
 */

/** Screens written; past it the index says how many were left out. */
const SCREEN_CAP = 5_000;
/** Flows written. */
const FLOW_CAP = 300;
/** Rows per list inside one file. */
const LIST_CAP = 100;
/** Functions one walk visits before it stops. */
const WALK_CAP = 3_000;
/** Tables named per effect line. */
const EFFECT_CAP = 12;
/** Screens drawn in the index's navigation map. */
const MAP_CAP = 60;

const FILE_NAMED = /^(?:index|page|\+page|route|default|_index|\[.*\])$/i;

const GENERIC_NOUNS = new Set(["one", "all", "many", "item", "items", "entity", "record", "data", "by", "id", "handler", "action", "async"]);

const FIELDS = new Set(["input", "select", "textarea"]);

const HTTP_CALL = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//;
/** Every `emit('x')` / `$emit('x')` a handler spells, wherever it sits — as the emit resolver reads markup. */
const EMIT_ANYWHERE = /(?:^|[^\w$.])\$?emit\s*\(\s*['"]([\w:.-]+)['"]/g;

const VERBS: Record<string, string> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", GET: "view" };
const EFFECT_WORDS: Record<string, string> = {
  "db-read": "reads",
  "db-write": "writes",
  db: "uses",
  "queue-publish": "publishes to",
  "queue-consume": "consumes",
};

type Key = string;
const keyOf = (file: string, symbol: string): Key => `${file}::${symbol}`;

interface RouteHit {
  method: string | null;
  path: string;
  file: string;
  line: number;
  handler: string | null;
  guards: string[];
  roles: string[];
  policies: string[];
  anonymous: boolean;
  /** What the route itself reads and writes, as its data flows say. */
  effects: Effect[];
}

interface Effect {
  kind: string;
  resource: string;
  /** Calls between the route's handler and the access; the nearest is what the route is for. */
  distance?: number;
}

interface Reach {
  routes: RouteHit[];
  effects: Effect[];
  /** URLs a visited function calls that no route in the analysis serves. */
  unrouted: string[];
}

interface Action {
  el: InteractiveElement;
  /** "Submit the form", "Click “Save”", "Change the input". */
  label: string;
  /** A field the user fills in rather than a control they use. */
  field: boolean;
  /** False when the handler names no function the analysis has. */
  found: boolean;
  reach: Reach;
}

interface Nav {
  text: string;
  target: Model | null;
  /** The component the link sits in, when it is not the screen's own. */
  via?: Model;
}

interface Model {
  screen: Screen;
  slug: string;
  title: string;
  route: string | null;
  project: string | null;
  actions: Action[];
  load: Reach;
  contains: Model[];
  usedOn: Model[];
  opens: Model[];
  openedBy: Model[];
  navTo: Nav[];
  navFrom: Array<{ from: Model; via?: Model }>;
  entry: "main" | "root" | "url" | null;
  flows: Flow[];
}

interface Step {
  screen: Model;
  /** The component the link that leads here sits in. */
  via?: Model;
  /** A component of the step before: the user is still on that page. */
  part?: true;
}

interface Flow {
  slug: string;
  title: string;
  path: Step[];
  action: Action;
  verb: string;
  object: string;
  goal: Goal;
}

/** An ASCII file name, unique per folder in the order asked. */
function slugger() {
  const taken = new Set<string>();
  return (text: string): string => {
    const base = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "screen";
    let slug = base;
    for (let n = 2; taken.has(slug.toLowerCase()); n++) slug = `${base}-${n}`;
    taken.add(slug.toLowerCase());
    return slug;
  };
}

/** A route path or a navigation target as segments, every parameter a `*`. */
function pathPattern(path: string): string | null {
  const p = path.trim().replace(/[?#].*$/s, "");
  if (!p.startsWith("/")) return null;
  const segments = p.split("/").filter(Boolean).map((s) => (/[:{[*$]/.test(s) ? "*" : s.toLowerCase()));
  return `/${segments.join("/")}`;
}

/** `` `text` `` with a fence the text cannot close. */
function code(text: string): string {
  const t = text.replace(/\r?\n/g, " ");
  return t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``;
}

/** Link text: brackets would end it. */
const linkText = (text: string) => text.replace(/[[\]]/g, (c) => `\\${c}`);

function list(items: string[], more = "more"): string[] {
  const lines = items.slice(0, LIST_CAP).map((i) => `- ${i}`);
  if (items.length > LIST_CAP) lines.push(`- … ${items.length - LIST_CAP} ${more}`);
  return lines;
}

function frontmatter(fields: Record<string, unknown>): string[] {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${typeof value === "number" ? value : JSON.stringify(String(value))}`);
  }
  lines.push("---", "");
  return lines;
}

const unique = <T>(items: T[], key: (t: T) => string = String): T[] => {
  const seen = new Set<string>();
  return items.filter((t) => !seen.has(key(t)) && seen.add(key(t)));
};

/** Every file of the bundle, the index first. */
export function screenSpecs(summary: Summary): BundleFile[] {
  const project = projectName(summary);
  const screens = (summary.screens ?? []).slice(0, SCREEN_CAP);
  const fileProjects = summary.fileProjects ?? {};
  const projectNames = new Map((summary.subProjects ?? []).map((p) => [p.id, p.name]));
  const routes = summary.routeMap ?? [];

  // The call graph, without import references and interface fan-out: those run nothing.
  const callees = new Map<Key, Array<{ to: Key; http: boolean }>>();
  const symbolsIn = new Map<string, Set<string>>();
  const calledByName = new Map<string, Key>();
  const addSymbol = (file: string, symbol: string) => (symbolsIn.get(file) ?? symbolsIn.set(file, new Set()).get(file)!).add(symbol);
  for (const l of summary.symbolLinks ?? []) {
    if (l.relation === "reference" || l.navigational || l.sourceSymbol.startsWith("(")) continue;
    const from = keyOf(l.sourceFile, l.sourceSymbol);
    const http = l.relation === "http" || HTTP_CALL.test(l.callName ?? "");
    (callees.get(from) ?? callees.set(from, []).get(from)!).push({ to: keyOf(l.targetFile, l.targetSymbol), http });
    addSymbol(l.sourceFile, l.sourceSymbol);
    addSymbol(l.targetFile, l.targetSymbol);
    if (l.callName) {
      const leaf = l.callName.replace(/\(.*$/s, "").trim().split(".").pop() ?? "";
      const k = `${l.sourceFile}||${leaf}`;
      if (!calledByName.has(k)) calledByName.set(k, keyOf(l.targetFile, l.targetSymbol));
    }
  }
  for (const c of summary.complexity ?? []) for (const f of c.functions ?? []) addSymbol(c.filePath, f.functionName);

  // The route an HTTP edge lands on: a `route:` symbol, or the handler function declared at the route.
  const routeAt = new Map<string, Route>();
  const routeByLabel = new Map<string, Route>();
  for (const r of routes) {
    if (r.kind !== "api" || !r.filePath) continue;
    routeAt.set(`${r.filePath}:${r.line}`, r);
    routeByLabel.set(`${r.filePath}|${`${r.httpMethod ?? ""} ${r.path}`.trim()}`, r);
  }
  const hitOf = (target: Key, targetLine: number | undefined, callName: string | undefined): RouteHit | null => {
    const sep = target.indexOf("::");
    const file = target.slice(0, sep);
    const symbol = target.slice(sep + 2);
    const m = /^route:(\S+) (.*)$/s.exec(symbol);
    const label = m ? `${m[1] === "USE" ? "" : m[1]} ${m[2]}`.trim() : null;
    const r = (label ? routeByLabel.get(`${file}|${label}`) : undefined) ?? (targetLine ? routeAt.get(`${file}:${targetLine}`) : undefined);
    if (r) {
      return {
        method: r.httpMethod, path: r.path, file, line: r.line, handler: r.handler,
        guards: r.middleware ?? [], roles: r.auth?.roles ?? [], policies: r.auth?.policies ?? [], anonymous: r.auth?.anonymous ?? false, effects: [],
      };
    }
    const called = m ? null : HTTP_CALL.exec(callName ?? "") && callName!.split(" ");
    if (m) return { method: m[1] === "USE" ? null : m[1]!, path: m[2]!, file, line: targetLine ?? 0, handler: null, guards: [], roles: [], policies: [], anonymous: false, effects: [] };
    if (called) return { method: called[0]!, path: called.slice(1).join(" "), file, line: targetLine ?? 0, handler: symbol, guards: [], roles: [], policies: [], anonymous: false, effects: [] };
    return null;
  };
  const httpLinks = new Map<Key, Array<{ to: Key; line?: number; callName?: string }>>();
  for (const l of summary.symbolLinks ?? []) {
    if (!(l.relation === "http" || HTTP_CALL.test(l.callName ?? ""))) continue;
    const from = keyOf(l.sourceFile, l.sourceSymbol);
    (httpLinks.get(from) ?? httpLinks.set(from, []).get(from)!).push({ to: keyOf(l.targetFile, l.targetSymbol), line: l.targetLine, callName: l.callName });
  }

  // What a route reaches, as its data flows say; what a function touches directly.
  const routeEffects = new Map<string, Effect[]>();
  for (const f of summary.dataFlows ?? []) {
    if (f.entryKind !== "route" || f.effect === "api-call") continue;
    const k = `${f.entryFile}|${f.entryLabel}`;
    (routeEffects.get(k) ?? routeEffects.set(k, []).get(k)!).push({ kind: f.effect, resource: f.resource, distance: f.distance });
  }
  const directData = new Map<Key, Effect[]>();
  for (const d of summary.symbolDataAccess ?? []) {
    if (!d.entityMatched && !d.access) continue;
    const writes = d.sites?.some((s) => s.access === "write");
    const reads = d.sites?.some((s) => s.access === "read");
    const kind = d.access ?? (writes ? "db-write" : reads ? "db-read" : "db");
    const k = keyOf(d.file, d.symbol);
    (directData.get(k) ?? directData.set(k, []).get(k)!).push({ kind, resource: d.datastore && d.access ? d.datastore : d.entity });
  }
  const directCalls = new Map<Key, string[]>();
  for (const r of summary.symbolReach ?? []) {
    const urls = r.effects.filter((e) => e.kind === "api-call" && !e.distance).map((e) => e.resource);
    if (urls.length) directCalls.set(keyOf(r.file, r.symbol), urls);
  }

  /** Everything reachable from `starts` by calls, never entering `avoid`; an HTTP edge ends the walk there. */
  const walk = (starts: Key[], avoid: Set<Key>): Reach => {
    const seen = new Set(starts);
    let frontier = [...starts];
    const hits: RouteHit[] = [];
    const effects: Effect[] = [];
    const unrouted: string[] = [];
    while (frontier.length && seen.size < WALK_CAP) {
      const next: Key[] = [];
      for (const k of frontier) {
        effects.push(...(directData.get(k) ?? []));
        const http = httpLinks.get(k) ?? [];
        for (const h of http) {
          const hit = hitOf(h.to, h.line, h.callName);
          if (!hit) continue;
          hit.effects = routeEffects.get(`${hit.file}|${`${hit.method ?? ""} ${hit.path}`.trim()}`) ?? [];
          hits.push(hit);
          effects.push(...hit.effects);
        }
        if (!http.length) unrouted.push(...(directCalls.get(k) ?? []).filter((u) => u.includes("/") && !/^[\w$.]+\(/.test(u)));
        for (const c of callees.get(k) ?? []) {
          if (c.http || seen.has(c.to) || avoid.has(c.to)) continue;
          seen.add(c.to);
          next.push(c.to);
        }
      }
      frontier = next;
    }
    return {
      routes: unique(hits, (h) => `${h.file}|${h.method} ${h.path}`),
      effects: unique(effects, (e) => `${e.kind} ${e.resource}`),
      unrouted: unique(unrouted),
    };
  };

  /**
   * The functions a handler runs: the one it names, in its screen's files by name or leaf, else the one its file
   * calls by that name; or, for a handler that emits, the parent handlers the emit links reach — an emit behind a
   * condition (`open ? emit('close') : emit('open')`) reaches each event it spells.
   */
  const handlerKeys = (handler: string, files: string[]): Key[] => {
    const emitted = (event: string) => calledByName.get(`${files[0]}||emit:${event}`);
    const emit = /^\$?emit\s*\(\s*['"]([\w:.-]+)['"]/.exec(handler) ?? /^(?:this\.)?([\w$]+)\.emit\b/.exec(handler);
    if (emit) return [emitted(emit[1]!)].filter((k): k is Key => !!k);
    const clean = handler.replace(/\(.*$/s, "").replace(/^(?:void|await|return)\s+|^!/, "").trim();
    if (clean && /^[\w.$]+$/.test(clean)) {
      const leaf = clean.split(".").pop()!;
      for (const file of files) for (const sym of symbolsIn.get(file) ?? []) if (sym === leaf || sym.endsWith(`.${leaf}`)) return [keyOf(file, sym)];
      for (const file of files) {
        const named = calledByName.get(`${file}||${leaf}`);
        if (named) return [named];
      }
      return [];
    }
    return unique([...handler.matchAll(EMIT_ANYWHERE)].map((m) => emitted(m[1]!)).filter((k): k is Key => !!k));
  };

  // One model per screen.
  const slug = slugger();
  const nameCount = new Map<string, number>();
  for (const s of screens) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
  const frontendByHandler = new Map<string, string | null>();
  for (const r of routes) if (r.kind === "frontend" && r.handler) frontendByHandler.set(r.handler, frontendByHandler.has(r.handler) ? null : r.path);
  const elementsByFile = new Map<string, InteractiveElement[]>();
  for (const e of summary.interactiveElements ?? []) (elementsByFile.get(e.filePath) ?? elementsByFile.set(e.filePath, []).get(e.filePath)!).push(e);

  // A page named by its file (`index.vue`, `[id].vue`, `+page.svelte`) is better known by its route.
  const routeOf = (screen: Screen) => screen.routePath || ((nameCount.get(screen.name) ?? 0) === 1 ? frontendByHandler.get(screen.name) ?? null : null);
  const proposed = screens.map((screen) => {
    const route = routeOf(screen);
    return route && (FILE_NAMED.test(screen.name) || (nameCount.get(screen.name) ?? 0) > 1) ? route : screen.name;
  });
  const titleUses = new Map<string, number>();
  for (const t of proposed) titleUses.set(t, (titleUses.get(t) ?? 0) + 1);
  const models: Model[] = screens.map((screen, i) => {
    const title = (titleUses.get(proposed[i]!) ?? 0) > 1 ? `${proposed[i]} (${screen.filePath})` : proposed[i]!;
    const pid = fileProjects[screen.filePath];
    return {
      screen, title, slug: slug(title), route: routeOf(screen) || null, project: pid ? projectNames.get(pid) ?? pid : null,
      actions: [], load: { routes: [], effects: [], unrouted: [] }, contains: [], usedOn: [], opens: [], openedBy: [],
      navTo: [], navFrom: [], entry: null, flows: [],
    };
  });

  // Actions first: every screen's handlers are known before any screen's load is walked.
  const handlers = new Set<Key>();
  const actionReach = new Map<string, Reach>();
  const filesOf = (m: Model) => unique([m.screen.filePath, ...(m.screen.codeFiles ?? [])]);
  for (const m of models) {
    const files = filesOf(m);
    for (const el of files.flatMap((f) => elementsByFile.get(f) ?? [])) {
      if (!el.handler && !el.request) continue;
      const ks = el.handler ? handlerKeys(el.handler, files) : [];
      for (const k of ks) handlers.add(k);
      const at = ks.join("\u0000");
      const walked = ks.length ? actionReach.get(at) ?? actionReach.set(at, walk(ks, new Set())).get(at)! : null;
      const reach: Reach = walked ? { ...walked, unrouted: [...walked.unrouted] } : { routes: [], effects: [], unrouted: [] };
      // A server-rendered form or link states its request outright.
      if (el.request) reach.unrouted.push(`${el.request.method.toUpperCase()} ${el.request.target}`);
      m.actions.push({ el, label: describe(el), field: FIELDS.has(el.element), found: ks.length > 0, reach });
    }
  }
  // What a screen loads: its component code and what it renders, short of any control's handler — a child's
  // delete button is the child's action, not something the page does when it opens.
  for (const m of models) {
    const symbols = filesOf(m).flatMap((f) => [...(symbolsIn.get(f) ?? [])].map((s) => keyOf(f, s)));
    const own = symbols.filter((k) => {
      const sym = k.slice(k.indexOf("::") + 2);
      return sym === m.screen.name || sym.startsWith(`${m.screen.name}.`) || sym === "<component>";
    });
    m.load = walk((own.length ? own : symbols).filter((k) => !handlers.has(k)), handlers);
  }

  // Composition: the components a screen renders, and the dialogs it opens.
  const byFile = new Map<string, Model[]>();
  for (const m of models) byFile.set(m.screen.filePath, [...(byFile.get(m.screen.filePath) ?? []), m]);
  const graph = summary.componentGraph ?? {};
  for (const m of models) {
    const imported = new Set(graph[m.screen.filePath] ?? []);
    const tags = new Set((summary.componentUsage ?? []).filter((u) => u.filePath === m.screen.filePath).map((u) => u.name));
    for (const file of imported) {
      for (const child of byFile.get(file) ?? []) {
        if (child === m || !tags.has(child.screen.name) || m.contains.includes(child)) continue;
        m.contains.push(child);
        child.usedOn.push(m);
      }
    }
  }
  for (const l of summary.componentLaunches ?? []) {
    for (const from of byFile.get(l.sourceFile) ?? []) {
      for (const to of byFile.get(l.targetFile) ?? []) {
        if (to === from || from.opens.includes(to)) continue;
        from.opens.push(to);
        to.openedBy.push(from);
      }
    }
  }

  // Navigation: a target names a screen, or a path one is mounted at.
  const byPattern = new Map<string, Model[]>();
  const byName = new Map<string, Model[]>();
  for (const m of models) {
    const p = m.route ? pathPattern(m.route) : null;
    if (p) byPattern.set(p, [...(byPattern.get(p) ?? []), m]);
    byName.set(m.screen.name, [...(byName.get(m.screen.name) ?? []), m]);
  }
  // Two apps in one repository both have a `/`: the link means the one in its own sub-project, then its own folder.
  const resolve = (text: string, from: Model): Model | null => {
    const p = pathPattern(text);
    let candidates = (p ? byPattern.get(p) : byName.get(text)) ?? [];
    if (candidates.length > 1) candidates = candidates.filter((c) => c.project === from.project);
    if (candidates.length > 1) {
      const shared = (c: Model) => commonPrefix(c.screen.filePath, from.screen.filePath);
      const best = Math.max(...candidates.map(shared));
      candidates = candidates.filter((c) => shared(c) === best);
    }
    return candidates.length === 1 ? candidates[0]! : null;
  };
  for (const m of models) {
    const own = (m.screen.navigatesTo ?? []).map((text) => ({ text, target: resolve(text, m) }));
    // A link in a component the screen renders (a header, a card) is one the screen offers.
    const inherited = m.contains.flatMap((c) => (c.screen.navigatesTo ?? []).map((text) => ({ text, target: resolve(text, c), via: c })));
    m.navTo = unique([...own, ...inherited], (n) => n.target?.slug ?? n.text).filter((n) => n.target !== m);
    for (const n of m.navTo) if (n.target) n.target.navFrom.push({ from: m, via: n.via });
  }

  // Entry screens: the one the app starts on, the root path, then pages opened only by URL.
  const isPage = (m: Model) => !!m.route || !m.usedOn.length;
  for (const m of models) {
    if (m.screen.startup === "main") m.entry = "main";
    else if (m.route && pathPattern(m.route) === "/") m.entry = "root";
  }
  if (!models.some((m) => m.entry)) for (const m of models) if (isPage(m) && !m.navFrom.length && !m.openedBy.length && m.route) m.entry = "url";
  const entries = models.filter((m) => m.entry);

  // Shortest navigation path to every screen, from any entry.
  const parent = new Map<Model, { from: Model; via?: Model } | null>();
  let frontier = entries;
  for (const e of entries) parent.set(e, null);
  while (frontier.length) {
    const next: Model[] = [];
    for (const m of frontier) {
      for (const n of m.navTo) {
        if (!n.target || parent.has(n.target)) continue;
        parent.set(n.target, { from: m, via: n.via });
        next.push(n.target);
      }
    }
    frontier = next;
  }
  const pathTo = (m: Model): Array<{ screen: Model; via?: Model }> => {
    if (!parent.has(m)) return [{ screen: m }];
    const steps: Array<{ screen: Model; via?: Model }> = [];
    let cur: Model | undefined = m;
    while (cur) {
      const p = parent.get(cur);
      steps.unshift({ screen: cur, via: p?.via });
      cur = p?.from;
    }
    return steps;
  };

  /** The way to a screen; to a component, the way to the page it is on (one users can reach, if any), then into it. */
  const placement = (m: Model, depth = 0): Step[] => {
    if (m.route || !m.usedOn.length || depth > 4) return pathTo(m);
    const host = m.usedOn.find((u) => parent.has(u)) ?? m.usedOn[0]!;
    return [...placement(host, depth + 1), { screen: m, part: true }];
  };

  // Flows: every action that changes data, reached the shortest way.
  const flowSlug = slugger();
  const flows: Flow[] = [];
  const titleCount = new Map<string, number>();
  const pending: Array<Omit<Flow, "slug" | "title">> = [];
  for (const m of models) {
    // Several controls doing the same thing (a toolbar's save and a form's) are one flow.
    const seen = new Set<string>();
    for (const a of m.actions) {
      const change = a.reach.routes.find((r) => r.method && r.method !== "GET");
      const write = a.reach.effects.find((e) => e.kind === "db-write" || e.kind === "queue-publish");
      if (!change && !write) continue;
      const g = goal(a);
      const { verb } = g;
      const object = g.object ?? a.el.handler ?? m.screen.name;
      const same = `${verb} ${object} ${a.reach.routes.map((r) => `${r.method} ${r.path}`).sort().join(",")}`;
      if (seen.has(same)) continue;
      seen.add(same);
      pending.push({ path: placement(m), action: a, verb, object, goal: { ...g, object } });
    }
  }
  const titleOf = (p: { verb: string; object: string; goal: Goal }) => p.goal.phrase ? capitalize(p.goal.phrase) : `${capitalize(p.verb)} ${p.object}`;
  for (const p of pending) titleCount.set(titleOf(p), (titleCount.get(titleOf(p)) ?? 0) + 1);
  for (const p of pending.slice(0, FLOW_CAP)) {
    const last = p.path[p.path.length - 1]!.screen;
    const base = titleOf(p);
    const title = (titleCount.get(base) ?? 0) > 1 ? `${base} on ${last.title}` : base;
    const flow: Flow = { ...p, title, slug: flowSlug(title) };
    flows.push(flow);
    for (const s of unique(p.path.map((x) => x.screen))) s.flows.push(flow);
  }

  const files: BundleFile[] = [
    { path: "README.md", content: indexDoc(project, summary.analyzedAt, models, flows, entries, pathTo, parent, (summary.screens?.length ?? 0) - screens.length) },
    ...models.map((m) => ({ path: `screens/${m.slug}.md`, content: screenDoc(m, pathTo(m), parent.has(m)) })),
    ...flows.map((f) => ({ path: `flows/${f.slug}.md`, content: flowDoc(f) })),
  ];
  return files;
}

/** What the user does, in words: the event's verb and the control it is on. */
function describe(el: InteractiveElement): string {
  const event = el.event.replace(/^(?:on|@|v-on:)/i, "").replace(/[.:].*$/, "");
  const verb = /^(?:submit|ngsubmit)$/i.test(event) ? "Submit" : /^(?:click|tap|press|dblclick)$/i.test(event) ? "Click"
    : /^(?:change|input|model|v-model|ngmodelchange|blur)$/i.test(event) ? "Change" : capitalize(event.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  const control = el.caption ? `“${el.caption}”` : el.component ? el.component : el.element === "custom" ? "the control" : `the ${el.element}`;
  return el.component && !/^(?:click|submit|change)$/i.test(event) ? `${verb} in ${control}` : `${verb} ${control}`;
}

/**
 * What an action does to what: the verb from the method of the route it sends
 * (a changing one first), the object from the table it writes or reads, else
 * the route's last literal segment. No object when neither says — the story
 * then names the control instead of guessing.
 */
/**
 * The backend handler's name as words, when it says what the action is for —
 * `UpdateMatchScore` → "update match score", `save_progress` → "save
 * progress". A generic CRUD name (`create_one`, `Post`, `Index`) says nothing
 * the method and the table do not.
 */
function handlerPhrase(handler: string | null): string | null {
  const leaf = (handler ?? "").split(/[.:#]/).pop()!.replace(/Async$/, "");
  const words = leaf.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length < 2 || !/^[a-z]+$/.test(words.join(""))) return null;
  if (words.length === 2 && GENERIC_NOUNS.has(words[1]!)) return null;
  return words.join(" ");
}

interface Goal {
  verb: string;
  object: string | null;
  /** The object is a table the route reads or writes, not a word of its path. */
  table?: true;
  phrase?: string;
}

function goal(a: Action): Goal {
  const named = a.reach.routes.find((r) => r.method && r.method !== "GET") ?? a.reach.routes.find((r) => r.method);
  const phrase = handlerPhrase(named?.handler ?? null) ?? undefined;
  return { ...entityGoal(a), ...(phrase ? { phrase } : {}) };
}

/** A story's "I can …": the handler's words with the table they touch, else verb and object. */
function canDo(g: Goal): string {
  if (g.phrase) return g.table ? `${g.phrase} (${g.verb} ${code(g.object!)})` : g.phrase;
  return `${g.verb} ${code(g.object!)}`;
}

function entityGoal(a: Action): Goal {
  const route = a.reach.routes.find((r) => r.method && r.method !== "GET") ?? a.reach.routes.find((r) => r.method);
  // The route the action sends speaks for it; everything else its chain touches is a side effect.
  const effects = [...(route ? route.effects : a.reach.effects)].sort((x, y) => (x.distance ?? 0) - (y.distance ?? 0));
  const write = effects.find((e) => e.kind === "db-write" || e.kind === "queue-publish");
  const read = effects.find((e) => e.kind === "db-read" || e.kind === "db");
  if (route?.method) {
    const entity = route.method === "GET" ? read ?? write : write;
    // A POST that writes no table is a request, not a creation: `POST /password/reset`.
    if (!entity) return { verb: route.method === "GET" ? "view" : route.method === "POST" ? "submit" : VERBS[route.method] ?? route.method.toLowerCase(), object: lastSegment(route.path) };
    return { verb: VERBS[route.method] ?? route.method.toLowerCase(), object: entity.resource, table: true };
  }
  if (write) return { verb: "change", object: write.resource, table: true };
  return read ? { verb: "view", object: read.resource, table: true } : { verb: "view", object: null };
}

/** Leading path segments two files share. */
function commonPrefix(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

function lastSegment(path: string): string | null {
  const segs = path.split("/").filter((s) => s && !/[:{[*$]/.test(s));
  return segs.pop() ?? null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const screenLink = (m: Model, prefix = "") => `[${linkText(m.title)}](${prefix}${m.slug}.md)`;
const flowLink = (f: Flow, prefix = "") => `[${linkText(f.title)}](${prefix}${f.slug}.md)`;
const routeText = (r: RouteHit) => code(`${r.method ?? ""} ${r.path}`.trim());
const at = (file: string, line?: number) => code(line && line > 0 ? `${file}:${line}` : file);

/** Who a route lets in, as its guards say: its roles, a visitor when it allows anyone, else a user. */
function actor(routes: RouteHit[]): string {
  const roles = unique(routes.flatMap((r) => r.roles));
  if (roles.length) return roles.join(" or ");
  const policies = unique(routes.flatMap((r) => r.policies));
  if (policies.length) return `user with ${policies.map(code).join(" and ")}`;
  if (routes.length && routes.every((r) => r.anonymous)) return "visitor";
  return "user";
}

function reachLines(r: Reach): string[] {
  const out: string[] = [];
  for (const h of r.routes) {
    const handled = h.line ? `, handled ${h.handler ? `by ${code(h.handler)} ` : ""}at ${at(h.file, h.line)}` : "";
    const guards = h.guards.length ? ` — requires ${h.guards.map(code).join(", ")}` : "";
    out.push(`Sends ${routeText(h)}${handled}${guards}`);
  }
  for (const u of r.unrouted) out.push(`Calls ${code(u)} — no route in this analysis serves it`);
  // One line per kind; a table both used and read or written is said once.
  const named = new Set(r.effects.filter((e) => e.kind !== "db").map((e) => e.resource));
  const byKind = new Map<string, string[]>();
  for (const e of r.effects) if (e.kind !== "db" || !named.has(e.resource)) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.resource]);
  for (const kind of ["db-write", "queue-publish", "db-read", "db", "queue-consume", ...byKind.keys()]) {
    const resources = byKind.get(kind);
    if (!resources) continue;
    byKind.delete(kind);
    const shown = resources.slice(0, EFFECT_CAP).map(code).join(", ");
    out.push(`${capitalize(EFFECT_WORDS[kind] ?? kind)} ${shown}${resources.length > EFFECT_CAP ? ` and ${resources.length - EFFECT_CAP} more` : ""}`);
  }
  return out;
}

function screenDoc(m: Model, path: Array<{ screen: Model; via?: Model }>, reachable: boolean): string {
  const s = m.screen;
  const lines = [
    ...frontmatter({ type: "screen", name: s.name, kind: s.formType, route: m.route, file: s.filePath, project: m.project, entry: m.entry }),
    `# ${m.title}`,
    "",
    `[All screens](../README.md) · ${[m.route ? `route ${code(m.route)}` : null, at(s.filePath), m.project ? `in ${m.project}` : null].filter(Boolean).join(" · ")}`,
  ];
  if (s.caption) lines.push("", `Title shown: “${s.caption}”`);

  const arrive: string[] = [];
  if (m.entry === "main") arrive.push("The app opens on this screen.");
  if (m.entry === "root") arrive.push(`It is the app's root path, ${code(m.route!)}.`);
  if (m.entry === "url") arrive.push(`Opened by its URL, ${code(m.route!)}; no screen in the analysis links here.`);
  arrive.push(...m.navFrom.map((n) => `From ${screenLink(n.from)}${n.via ? ` (a link in ${screenLink(n.via)})` : ""}`));
  arrive.push(...m.openedBy.map((o) => `Opened by ${screenLink(o)}`));
  arrive.push(...m.usedOn.filter((u) => !m.navFrom.some((n) => n.from === u)).map((u) => `Shown as part of ${screenLink(u)}`));
  if (reachable && path.length > 1) arrive.push(`Shortest way in: ${path.map((p) => screenLink(p.screen)).join(" → ")}`);
  lines.push("", "## How users get here", "", ...(arrive.length ? list(arrive) : ["No navigation into this screen was found in the code."]));

  const load = reachLines(m.load);
  if (load.length) lines.push("", "## What it loads", "", ...list(load));

  const reaches = reachesAnything;
  const real = m.actions.filter(reaches);
  const fields = m.actions.filter((a) => a.field && !reaches(a));
  const rest = m.actions.filter((a) => !a.field && !reaches(a));
  // A component's handler that is none of its own functions is usually a callback prop: the page that renders it decides.
  const handedUp = m.usedOn.length ? rest.filter((a) => !a.found) : [];
  const uiOnly = rest.filter((a) => a.found);
  const other = rest.filter((a) => !a.found && !handedUp.includes(a));
  const used = (a: Action) => `${a.label}${a.el.handler ? ` → ${code(a.el.handler)}` : ""} (line ${a.el.line})`;
  if (fields.length) lines.push("", "## Fields", "", ...list(fields.map(used)));
  if (m.actions.length > fields.length) {
    lines.push("", "## What the user can do");
    real.forEach((a, i) => {
      lines.push("", `### ${i + 1}. ${a.label}${a.el.handler ? ` → ${code(a.el.handler)}` : ""}`, "", `${code(a.el.event)} at ${at(a.el.filePath, a.el.line)}`, "", ...list(reachLines(a.reach)));
    });
    if (uiOnly.length) lines.push("", "Changes only what the screen shows (no API call or data reached):", "", ...list(uiOnly.map(used)));
    if (handedUp.length) lines.push("", `Handed to the page that renders it (${m.usedOn.map((u) => screenLink(u)).join(", ")}):`, "", ...list(handedUp.map(used)));
    if (other.length) lines.push("", "Runs code the analysis does not follow (a library call, or a function it could not find):", "", ...list(other.map(used)));
  }

  if (m.contains.length) lines.push("", "## Built from", "", ...list(m.contains.map((c) => screenLink(c))));
  // What users do on the page happens as much in its components as in the page itself.
  const inside = descendants(m).filter((c) => c.actions.some(reachesAnything));
  if (inside.length) {
    lines.push("", "## What the user can do in its components", "", ...list(inside.map((c) =>
      `${screenLink(c)} — ${unique(c.actions.filter(reachesAnything).map((a) => { const g = goal(a); return g.object ? canDo(g) : a.label.toLowerCase(); })).join(", ")}`)));
  }
  if (m.opens.length) lines.push("", "## Opens", "", ...list(m.opens.map((o) => screenLink(o))));
  if (m.navTo.length) {
    lines.push("", "## Leads to", "", ...list(m.navTo.map((n) =>
      `${n.target ? screenLink(n.target) : "no screen found for"} ${code(n.text)}${n.via ? ` (a link in ${screenLink(n.via)})` : ""}`)));
  }
  if (m.flows.length) lines.push("", "## User flows through this screen", "", ...list(m.flows.map((f) => flowLink(f, "../flows/"))));

  const stories = storyDrafts(m, real);
  if (stories.length) {
    lines.push("", "## Story drafts", "", "Worded from the code alone — the reason a user wants each one is yours to add.", "", ...stories);
  }
  return lines.join("\n") + "\n";
}

const reachesAnything = (a: Action) => a.reach.routes.length > 0 || a.reach.effects.length > 0 || a.reach.unrouted.length > 0;

/** The components a screen renders, theirs in turn, three deep. */
function descendants(m: Model): Model[] {
  const out: Model[] = [];
  let level = m.contains;
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: Model[] = [];
    for (const c of level) {
      if (c === m || out.includes(c)) continue;
      out.push(c);
      next.push(...c.contains);
    }
    level = next;
  }
  return out;
}

function storyDrafts(m: Model, actions: Action[]): string[] {
  const out: string[] = [];
  const reads = m.load.effects.filter((e) => e.kind === "db-read" || e.kind === "db");
  if (reads.length || m.load.routes.length) {
    const what = reads.length ? reads.slice(0, EFFECT_CAP).map((e) => code(e.resource)).join(", ") : `what ${m.load.routes.slice(0, 3).map(routeText).join(", ")} ${m.load.routes.length > 1 ? "return" : "returns"}`;
    out.push(`- As a ${actor(m.load.routes)}, I can see ${what} on **${m.title}**.`);
    out.push(...m.load.routes.slice(0, 5).map((r) => `  - Loads ${routeText(r)}`));
  }
  for (const a of actions) {
    const g = goal(a);
    const how = `${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}`;
    out.push(g.object
      ? `- As a ${actor(a.reach.routes)}, I can ${canDo(g)} on **${m.title}** (${how}).`
      : `- As a ${actor(a.reach.routes)}, I can ${how} on **${m.title}**.`);
    out.push(...reachLines(a.reach).slice(0, 5).map((l) => `  - ${l}`));
  }
  return out;
}

function flowDoc(f: Flow): string {
  const last = f.path[f.path.length - 1]!.screen;
  const a = f.action;
  const id = idFactory("s");
  const chart = ["```mermaid", "flowchart LR"];
  f.path.forEach((p, i) => {
    chart.push(`  ${id(`s${i}`)}["${mermaidLabel(p.screen.title)}"]`);
    if (i) chart.push(`  ${id(`s${i - 1}`)} ${p.part ? "-.->" : "-->"} ${id(`s${i}`)}`);
  });
  let prev = id(`s${f.path.length - 1}`);
  chart.push(`  ${id("act")}(["${mermaidLabel(a.label)}"])`, `  ${prev} --> ${id("act")}`);
  prev = id("act");
  // Each route to the tables it reads and writes itself; an action with no route, to what it touches directly.
  const sources = a.reach.routes.length ? a.reach.routes.map((r, i) => ({ node: id(`r${i}`), route: r as RouteHit | null, effects: r.effects })) : [{ node: prev, route: null, effects: a.reach.effects }];
  const tables = idFactory("d");
  for (const src of sources) {
    if (src.route) chart.push(`  ${src.node}["${mermaidLabel(`${src.route.method ?? ""} ${src.route.path}`.trim())}"]`, `  ${prev} --> ${src.node}`);
    const byResource = new Map<string, string[]>();
    for (const e of src.effects) byResource.set(e.resource, [...(byResource.get(e.resource) ?? []), EFFECT_WORDS[e.kind] ?? e.kind]);
    for (const [resource, words] of [...byResource].slice(0, EFFECT_CAP)) {
      const node = `t_${tables(resource)}`;
      chart.push(`  ${node}[("${mermaidLabel(resource)}")]`, `  ${src.node} -->|"${mermaidLabel(unique(words).join(", "))}"| ${node}`);
    }
  }
  chart.push("```");

  const steps: string[] = [];
  f.path.forEach((p, i) => {
    if (i === 0) {
      const how = p.screen.entry === "main" ? " — the app opens here" : p.screen.entry === "root" ? ` — the app's root path, ${code(p.screen.route!)}` : p.screen.entry === "url" ? ` — by its URL, ${code(p.screen.route!)}` : p.screen.route ? ` at ${code(p.screen.route)}` : "";
      steps.push(`Open ${screenLink(p.screen, "../screens/")}${how}.`);
    } else if (p.part) {
      steps.push(`On it, find ${screenLink(p.screen, "../screens/")}.`);
    } else {
      steps.push(`Go to ${screenLink(p.screen, "../screens/")}${p.via ? ` through the link in ${screenLink(p.via, "../screens/")}` : ""}.`);
    }
  });
  if (!f.path[0]!.screen.entry) steps.splice(1, 0, `(No navigation into ${f.path[0]!.screen.title} was found; it is opened directly or by code the analysis does not trace.)`);
  steps.push(`${a.label} (${a.el.handler ? `runs ${code(a.el.handler)}, ` : ""}${at(a.el.filePath, a.el.line)}).`);
  steps.push(...reachLines(a.reach).map((l) => `${l}.`));

  const lines = [
    ...frontmatter({ type: "flow", goal: f.title, ends: last.screen.name, steps: steps.length }),
    `# ${f.title}`,
    "",
    `[All screens](../README.md) · ends on ${screenLink(last, "../screens/")}`,
    "",
    ...chart,
    "",
    "## Steps",
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Story draft",
    "",
    `As a ${actor(a.reach.routes)}, I can ${canDo(f.goal)} from **${last.title}**${f.path.length > 1 && f.path[f.path.length - 1]!.part ? ` on **${f.path[f.path.length - 2]!.screen.title}**` : ""}.`,
  ];
  return lines.join("\n") + "\n";
}

function indexDoc(
  project: string,
  analyzedAt: string | undefined,
  models: Model[],
  flows: Flow[],
  entries: Model[],
  pathTo: (m: Model) => Array<{ screen: Model; via?: Model }>,
  parent: Map<Model, unknown>,
  leftOut: number,
): string {
  const pages = models.filter((m) => m.route || !m.usedOn.length);
  const parts = models.filter((m) => !pages.includes(m));
  const actions = models.reduce((n, m) => n + m.actions.length, 0);
  const lost = models.reduce((n, m) => n + m.actions.filter((a) => !a.found && !a.field && !m.usedOn.length).length, 0);
  const lines = [
    ...frontmatter({ type: "index", project, analyzedAt }),
    `# Screens of ${project}`,
    "",
    `${plural(models.length, "screen")} (${plural(pages.length, "page")}, ${plural(parts.length, "component")}), ${plural(actions, "user action")} and ${plural(flows.length, "user flow")}, read from the code${analyzedAt ? ` as analyzed ${analyzedAt}` : ""}. Each screen's file says how users get there, what it loads, what every action on it sends and changes, and where it leads.`,
  ];
  if (leftOut > 0) lines.push("", `${leftOut} more screens were not written (${SCREEN_CAP}-screen cap).`);

  // The navigation map: pages and the links between them, the busiest first.
  const degree = (m: Model) => m.navTo.filter((n) => n.target).length + m.navFrom.length;
  const drawn = new Set(pages.filter((m) => degree(m) > 0).sort((a, b) => degree(b) - degree(a)).slice(0, MAP_CAP));
  if (drawn.size) {
    const id = idFactory("s");
    const chart = ["```mermaid", "flowchart LR"];
    for (const m of drawn) chart.push(`  ${id(m.slug)}["${mermaidLabel(m.route ? `${m.title} ${m.route}` : m.title)}"]`);
    const edges = new Set<string>();
    for (const m of drawn) for (const n of m.navTo) if (n.target && drawn.has(n.target)) edges.add(`  ${id(m.slug)} --> ${id(n.target.slug)}`);
    chart.push(...edges, "```");
    lines.push("", "## Navigation map", "", ...(drawn.size < pages.filter((m) => degree(m) > 0).length ? [`The ${MAP_CAP} most linked pages.`, ""] : []), ...chart);
  }

  if (entries.length) lines.push("", "## Where users start", "", ...entries.map((m) => `- ${screenLink(m, "screens/")}${m.route ? ` ${code(m.route)}` : ""}`));

  if (flows.length) {
    lines.push("", "## User flows", "", "Each ends in an action that changes data, reached the shortest way from where users start; grouped by what it changes.");
    const byObject = new Map<string, Flow[]>();
    for (const f of flows) byObject.set(f.object, [...(byObject.get(f.object) ?? []), f]);
    for (const [object, group] of [...byObject].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push("", `### ${object}`, "", ...group.map((f) => `- ${flowLink(f, "flows/")} — ${f.path.map((p) => p.screen.title).join(" → ")}`));
    }
  }

  lines.push("", "## Pages", "", "| Screen | Route | Actions | Sends | Writes | Way in |", "|---|---|---|---|---|---|");
  for (const m of pages) {
    const sends = unique([...m.load.routes, ...m.actions.flatMap((a) => a.reach.routes)], (r) => `${r.method} ${r.path}`).length;
    const writes = unique(m.actions.flatMap((a) => a.reach.effects).filter((e) => e.kind === "db-write").map((e) => e.resource));
    const way = m.entry ? "start" : parent.has(m) ? pathTo(m).map((p) => p.screen.title).join(" → ") : "—";
    lines.push(`| ${screenLink(m, "screens/").replace(/\|/g, "\\|")} | ${m.route ? code(m.route).replace(/\|/g, "\\|") : "—"} | ${m.actions.length} | ${sends} | ${writes.map((w) => code(w)).join(", ").replace(/\|/g, "\\|") || "—"} | ${way.replace(/\|/g, "\\|")} |`);
  }
  if (parts.length) {
    lines.push("", "## Components", "", "Parts of pages; each is listed with the pages it appears on.", "");
    lines.push(...parts.map((m) => `- ${screenLink(m, "screens/")} — on ${m.usedOn.map((u) => screenLink(u, "screens/")).join(", ")}`));
  }
  const unresolved = models.flatMap((m) => m.navTo.filter((n) => !n.target).map((n) => `${screenLink(m, "screens/")} → ${code(n.text)}`));
  if (lost || unresolved.length) {
    lines.push("", "## What the analysis could not follow", "");
    if (lost) lines.push(`- ${plural(lost, "action")} whose handler names no function the analysis has; each screen lists its own.`);
    if (unresolved.length) lines.push(`- ${plural(unresolved.length, "navigation target")} with no screen mounted at it:`, ...list(unresolved).map((l) => `  ${l}`));
  }
  return lines.join("\n") + "\n";
}
