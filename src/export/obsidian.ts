import { routeChains } from "./mermaid.js";
import { projectName } from "./markdown.js";
import type { EntityNode, Route, Screen, Summary } from "./types.js";
import { plural } from "./text.js";

/**
 * The analysis as an Obsidian vault: a note per route, screen, entity and
 * sub-project, joined by wikilinks along the chain ClarifyDoc answers — a
 * screen links the routes it calls, a route the entities it reaches, an entity
 * back to both — so Obsidian's graph view and backlinks walk it. Each note has
 * YAML frontmatter (Dataview reads it) and names the `path:line` it came from.
 *
 * Note names are the thing itself (`GET /api/users/:id`) with the characters a
 * file name cannot hold swapped for look-alikes; the link's alias keeps the
 * original text.
 */

export interface BundleFile {
  /** Path inside the bundle, posix-style. */
  path: string;
  content: string;
}

/** Notes per kind, past which the index says how many were left out. */
const NOTE_CAP = 5_000;
/** Rows per list inside one note. */
const LIST_CAP = 200;

/** A file name Obsidian (and Windows) accepts, readable as the original. */
function noteName(text: string): string {
  const name = text
    .replace(/\//g, "∕")
    .replace(/:/g, "꞉")
    .replace(/[\\*"<>|?#^[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "_");
  return (name || "_").slice(0, 120);
}

/** `[[Folder/Note|shown text]]`; the alias cannot hold `|` or `]`. */
const link = (path: string, shown: string) => `[[${path}|${shown.replace(/[|\]]/g, "¦")}]]`;

/** YAML frontmatter: every value a JSON string, which YAML reads as a double-quoted scalar. */
function frontmatter(fields: Record<string, unknown>): string[] {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${typeof value === "number" ? value : JSON.stringify(String(value))}`);
  }
  lines.push("---", "");
  return lines;
}

/** `` `path:line` ``, with a fence the text cannot close. */
function at(file: string, line?: number): string {
  const text = line && line > 0 ? `${file}:${line}` : file;
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** One name per key, made unique with ` (2)`, ` (3)` … in the order asked. */
function namer(folder: string) {
  const taken = new Map<string, number>();
  const byKey = new Map<string, string>();
  return (key: string, text: string): string => {
    const known = byKey.get(key);
    if (known) return known;
    const base = noteName(text);
    const n = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), n);
    const path = `${folder}/${n === 1 ? base : `${base} (${n})`}`;
    byKey.set(key, path);
    return path;
  };
}

function list(items: string[], more = "more"): string[] {
  const lines = items.slice(0, LIST_CAP).map((i) => `- ${i}`);
  if (items.length > LIST_CAP) lines.push(`- … ${items.length - LIST_CAP} ${more}`);
  return lines;
}

/** Every note of the vault, the index first. */
export function obsidianVault(summary: Summary): BundleFile[] {
  const project = projectName(summary);
  const routes = (summary.routeMap ?? []).slice(0, NOTE_CAP);
  const screens = (summary.screens ?? []).slice(0, NOTE_CAP);
  const entities = (summary.entityGraph?.nodes ?? []).slice(0, NOTE_CAP);
  const subProjects = summary.subProjects ?? [];
  const fileProjects = summary.fileProjects ?? {};
  const chains = new Map(routeChains(summary).map((c) => [c.key, c]));

  const routeKey = (r: { filePath?: string | null; httpMethod: string | null; path: string }) => `${r.filePath ?? ""}|${`${r.httpMethod ?? ""} ${r.path}`.trim()}`;
  const routeLabel = (r: Route) => `${r.httpMethod ?? ""} ${r.path}`.trim();
  const routeNote = namer("Routes");
  const screenNote = namer("Screens");
  const entityNote = namer("Entities");
  const projectNote = namer("Sub-projects");
  for (const r of routes) routeNote(routeKey(r), routeLabel(r));
  for (const s of screens) screenNote(`${s.filePath}|${s.name}`, s.name);
  for (const e of entities) entityNote(e.id, e.name);
  for (const p of subProjects) projectNote(p.id, p.name);

  // Joins, each on facts the analysis keyed the same way.
  const entityByName = new Map<string, EntityNode | null>();
  for (const e of entities) {
    const k = e.name.toLowerCase();
    entityByName.set(k, entityByName.has(k) ? null : e);
  }
  const entityFor = (resource: string) => entityByName.get(resource.toLowerCase()) ?? null;
  const screensByFile = new Map<string, Screen[]>();
  for (const s of screens) screensByFile.set(s.filePath, [...(screensByFile.get(s.filePath) ?? []), s]);
  const screenByName = new Map<string, Screen | null>();
  for (const s of screens) screenByName.set(s.name, screenByName.has(s.name) ? null : s);
  // `navigatesTo` names a screen or the route path it is mounted at.
  const screenByRoute = new Map<string, Screen | null>();
  for (const s of screens) if (s.routePath) screenByRoute.set(s.routePath, screenByRoute.has(s.routePath) ? null : s);
  const screenLink = (s: Screen) => link(screenNote(`${s.filePath}|${s.name}`, s.name), s.name);
  const routeLink = (r: Route) => link(routeNote(routeKey(r), routeLabel(r)), routeLabel(r));
  const entityLink = (e: EntityNode) => link(entityNote(e.id, e.name), e.name);
  const projectLink = (id: string) => {
    const p = subProjects.find((x) => x.id === id);
    return p ? link(projectNote(p.id, p.name), p.name) : id;
  };
  const routesByKey = new Map(routes.map((r) => [routeKey(r), r]));
  const routesByFile = new Map<string, Route[]>();
  for (const r of routes) if (r.filePath) routesByFile.set(r.filePath, [...(routesByFile.get(r.filePath) ?? []), r]);

  /** Route keys a calling file reaches. */
  const callsFrom = new Map<string, Set<string>>();
  /** Route keys whose data effects name an entity, by entity id. */
  const routesReaching = new Map<string, Set<string>>();
  for (const [key, chain] of chains) {
    if (!routesByKey.has(key)) continue;
    for (const c of chain.callers) callsFrom.set(c.file, (callsFrom.get(c.file) ?? new Set()).add(key));
    for (const ef of chain.effects) {
      const e = entityFor(ef.resource);
      if (e) routesReaching.set(e.id, (routesReaching.get(e.id) ?? new Set()).add(key));
    }
  }
  const screenFlows = (s: Screen) => (summary.dataFlows ?? []).filter((f) => f.entryKind === "screen" && f.entryFile === s.filePath);

  const files: BundleFile[] = [];

  for (const r of routes) {
    const chain = chains.get(routeKey(r));
    const callers = chain?.callers ?? [];
    const lines = [
      ...frontmatter({ type: "route", kind: r.kind, method: r.httpMethod, path: r.path, handler: r.handler, file: r.filePath, line: r.line, project: r.filePath ? fileProjects[r.filePath] : undefined }),
      `# ${routeLabel(r)}`,
      "",
      `Declared at ${at(r.filePath ?? "?", r.line)}${r.handler ? `, handled by \`${r.handler}\`` : ""}${r.filePath && fileProjects[r.filePath] ? ` in ${projectLink(fileProjects[r.filePath]!)}` : ""}.`,
      ...(r.middleware?.length ? ["", `Guards: ${r.middleware.map((m) => `\`${m}\``).join(", ")}.`] : []),
    ];
    if (callers.length) {
      lines.push("", "## Called from", "", ...list(callers.map((c) => {
        const from = screensByFile.get(c.file);
        return `${from ? `${from.map(screenLink).join(", ")} — ` : ""}${at(c.file, c.line)}${c.confidence && c.confidence !== "EXTRACTED" ? ` (${c.confidence.toLowerCase()})` : ""}`;
      })));
    }
    if (chain?.effects.length) {
      lines.push("", "## Reaches", "", ...list(chain.effects.map((ef) => {
        const e = entityFor(ef.resource);
        return `${ef.effect} ${e ? entityLink(e) : `\`${ef.resource}\``}${ef.distance ? ` — ${plural(ef.distance, "hop")}` : ""}`;
      })));
    }
    files.push({ path: `${routeNote(routeKey(r), routeLabel(r))}.md`, content: lines.join("\n") + "\n" });
  }

  for (const s of screens) {
    const called = [...(callsFrom.get(s.filePath) ?? [])].map((k) => routesByKey.get(k)!).filter(Boolean);
    const own = (s.routePath ? routesByFile.get(s.filePath) ?? [] : []).filter((r) => r.kind !== "api" && r.path === s.routePath);
    const navigates = (s.navigatesTo ?? []).map((n) => {
      const target = screenByName.get(n) ?? screenByRoute.get(n);
      return target ? screenLink(target) : `\`${n}\``;
    });
    const reaches = screenFlows(s).filter((f) => f.effect !== "api-call").map((f) => {
      const e = entityFor(f.resource);
      return `${f.effect} ${e ? entityLink(e) : `\`${f.resource}\``}`;
    });
    const lines = [
      ...frontmatter({ type: "screen", name: s.name, route: s.routePath, file: s.filePath, project: fileProjects[s.filePath] }),
      `# ${s.name}`,
      "",
      `${at(s.filePath)}${s.routePath ? ` at \`${s.routePath}\`` : ""}${fileProjects[s.filePath] ? ` in ${projectLink(fileProjects[s.filePath]!)}` : ""}.${own.length ? ` Its route: ${own.map(routeLink).join(", ")}.` : ""}`,
    ];
    if (called.length) lines.push("", "## Calls", "", ...list(unique(called.map(routeLink))));
    if (reaches.length) lines.push("", "## Reaches", "", ...list(unique(reaches)));
    if (navigates.length) lines.push("", "## Navigates to", "", ...list(navigates));
    files.push({ path: `${screenNote(`${s.filePath}|${s.name}`, s.name)}.md`, content: lines.join("\n") + "\n" });
  }

  const edges = summary.entityGraph?.edges ?? [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    const columns = e.columns ?? [];
    const related = edges.filter((x) => x.source === e.id || x.target === e.id).map((x) => {
      const other = byId.get(x.source === e.id ? x.target : x.source);
      const card = x.source === e.id ? `${x.sourceCardinality}-to-${x.targetCardinality}` : `${x.targetCardinality}-to-${x.sourceCardinality}`;
      return other ? `${entityLink(other)} (${card}${x.fields?.length ? `, ${x.fields.join(", ")}` : ""})` : "";
    }).filter(Boolean);
    const access = (summary.symbolDataAccess ?? []).filter((a) => a.entity === e.name).map((a) => `\`${a.symbol}\` — ${at(a.file, a.symbolLine)}`);
    const reached = [...(routesReaching.get(e.id) ?? [])].map((k) => routesByKey.get(k)!).filter(Boolean);
    const lines = [
      ...frontmatter({ type: "entity", name: e.name, kind: e.kind, orm: e.orm, file: e.filePath, line: e.line, columns: columns.length, project: fileProjects[e.filePath] }),
      `# ${e.name}`,
      "",
      `${e.orm ? `${e.orm} ` : ""}${e.kind} declared at ${at(e.filePath, e.line)}.`,
    ];
    if (columns.length) {
      lines.push("", "| Column | Type | Key |", "|---|---|---|", ...columns.slice(0, LIST_CAP).map((c) =>
        `| ${c.name.replace(/\|/g, "\\|")} | ${(c.type ?? "").replace(/\|/g, "\\|")} | ${c.isPrimaryKey ? "PK" : c.isForeignKey ? "FK" : ""} |`));
    }
    if (related.length) lines.push("", "## Related", "", ...list(unique(related)));
    if (reached.length) lines.push("", "## Reached by routes", "", ...list(unique(reached.map(routeLink))));
    if (access.length) lines.push("", "## Read and written by", "", ...list(unique(access)));
    files.push({ path: `${entityNote(e.id, e.name)}.md`, content: lines.join("\n") + "\n" });
  }

  for (const p of subProjects) {
    const own = routes.filter((r) => r.filePath && fileProjects[r.filePath] === p.id);
    const ownScreens = screens.filter((s) => fileProjects[s.filePath] === p.id);
    const ownEntities = entities.filter((e) => fileProjects[e.filePath] === p.id);
    const lines = [
      ...frontmatter({ type: "sub-project", name: p.name, kind: p.kind, root: p.root, frameworks: (p.frameworks ?? []).map((f) => f.name).join(", ") }),
      `# ${p.name}`,
      "",
      `${p.kind} at \`${p.root || "."}\`${p.frameworks?.length ? ` — ${p.frameworks.map((f) => f.name).join(", ")}` : ""}.`,
    ];
    if (own.length) lines.push("", `## Routes (${own.length})`, "", ...list(own.map(routeLink)));
    if (ownScreens.length) lines.push("", `## Screens (${ownScreens.length})`, "", ...list(ownScreens.map(screenLink)));
    if (ownEntities.length) lines.push("", `## Entities (${ownEntities.length})`, "", ...list(ownEntities.map(entityLink)));
    files.push({ path: `${projectNote(p.id, p.name)}.md`, content: lines.join("\n") + "\n" });
  }

  const left = (all: number, kept: number, noun: string) => (all > kept ? [`- … ${all - kept} more ${noun} not written (${NOTE_CAP}-note cap)`] : []);
  const index = [
    ...frontmatter({ type: "index", project, analyzedAt: summary.analyzedAt }),
    `# ${project}`,
    "",
    `The ClarifyDoc map of ${project}${summary.analyzedAt ? `, analyzed ${summary.analyzedAt}` : ""}: ${plural(routes.length, "route")}, ${plural(screens.length, "screen")}, ${plural(entities.length, "entity", "entities")}. Open the graph view to walk screen → route → entity.`,
    ...(subProjects.length ? ["", "## Sub-projects", "", ...subProjects.map((p) => `- ${link(projectNote(p.id, p.name), p.name)}`)] : []),
    ...(screens.length ? ["", "## Screens", "", ...list(screens.map(screenLink)), ...left(summary.screens?.length ?? 0, screens.length, "screens")] : []),
    ...(routes.length ? ["", "## Routes", "", ...list(routes.map(routeLink), "more — every route has its note under Routes/"), ...left(summary.routeMap?.length ?? 0, routes.length, "routes")] : []),
    ...(entities.length ? ["", "## Entities", "", ...list(entities.map(entityLink)), ...left(summary.entityGraph?.nodes?.length ?? 0, entities.length, "entities")] : []),
  ];
  return [{ path: `${noteName(project)}.md`, content: index.join("\n") + "\n" }, ...files];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
