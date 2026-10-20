/**
 * Names for the import-graph communities, and the levels above them:
 * module (the community) → subsystem → system (the sub-project). A Louvain
 * community is numbered by size, which says nothing and shifts between runs;
 * its name is the folder most of its files sit in, relative to the
 * sub-project — so "src/orders" reads, and survives a re-run that renumbers.
 *
 *  - system: the sub-project most of its files belong to (absent when one
 *    project holds the whole analysis);
 *  - name: the deepest folder holding at least 35% of the files, with its
 *    share when under 60% (`mealie/routes (45%)`);
 *    failing that the two folders most of it sits in (`api + web`);
 *  - subsystem: the name's first two folders;
 *  - slug: the name, lower-cased and dashed — two communities that would
 *    share one get their dominant file's name added.
 *
 * When the folders say little (spread over two, or the deepest under 60%),
 * what the community serves names it better: the path prefix most of its
 * routes share (`/api/orders`), else the entity its functions reach most
 * (`Order`). `nameBasis` records which rule named it, so a reader can weigh
 * it — folder names are how such clusters collapse back into directories.
 * With `groups` (the level above, `groupCommunities`), `group` names the
 * cluster of clusters it belongs to; with `links` and `anchors`, `orphan`
 * marks one of several files that no other community links to or from and
 * that declares no route or screen — code nothing reaches by structure.
 */

export interface CommunityName {
  name: string;
  slug: string;
  subsystem: string;
  system?: string;
  /** Which rule named it. */
  nameBasis?: "folder" | "folders" | "routes" | "entity";
  /** The name of its group, the level above. */
  group?: string;
  /** No link to or from another community, and no route or screen in it. */
  orphan?: true;
}

export interface CommunityNameContext {
  fileProjects?: Readonly<Record<string, string>>;
  projects?: ReadonlyArray<{ id: string; name: string; root: string }>;
  /** Routes by declaring file, for the route-prefix fallback. */
  routes?: ReadonlyArray<{ filePath?: string | null; path: string; kind?: string }>;
  /** What functions read and write, by file, for the entity fallback. */
  access?: ReadonlyArray<{ file: string; entity: string }>;
  /** Community id → group id (`groupCommunities`). */
  groups?: Readonly<Record<string, string>>;
  /** File links, and the files with a route or a screen, for `orphan`. */
  links?: ReadonlyArray<{ source: string; target: string }>;
  anchors?: ReadonlySet<string>;
}

const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

/** The value at least half of `items` share (and at least two), else null. */
function dominant(items: readonly string[]): string | null {
  if (items.length < 2) return null;
  const tally = new Map<string, number>();
  for (const x of items) tally.set(x, (tally.get(x) ?? 0) + 1);
  const [top, n] = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
  return n >= 2 && n >= Math.ceil(items.length / 2) ? top : null;
}

/** `/api/orders/:id/lines` → `/api/orders`, `/api/v1/users` → `/api/v1/users`: through `api` and versions to the first segment that names something. */
function routePrefix(path: string): string {
  const segs = path.split("/").filter((x) => x && !/^[:{*]/.test(x));
  const lead = segs.findIndex((x) => !/^(?:api|rest|v\d+(?:\.\d+)?)$/i.test(x));
  return `/${segs.slice(0, lead < 0 ? segs.length : lead + 1).join("/")}`;
}

export function nameCommunities(
  communities: Readonly<Record<string, readonly string[]>>,
  ctx: CommunityNameContext = {},
): Record<string, CommunityName> {
  const projectById = new Map((ctx.projects ?? []).map((p) => [p.id, p]));
  const multiProject = (ctx.projects ?? []).filter((p) => p.id !== "root").length >= 2;
  const out: Record<string, CommunityName> = {};
  const used = new Map<string, number>();
  for (const [id, files] of Object.entries(communities)) {
    if (files.length === 0) continue;
    // The sub-project most files belong to, and its root to name folders from.
    const tally = new Map<string, number>();
    for (const f of files) {
      const p = ctx.fileProjects?.[f] ?? "root";
      tally.set(p, (tally.get(p) ?? 0) + 1);
    }
    const [projectId] = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    const project = projectById.get(projectId);
    const root = project && project.root ? project.root.replace(/\/+$/, "") : "";
    const rel = (d: string) => (root && (d === root || d.startsWith(root + "/")) ? d.slice(root.length).replace(/^\//, "") : d);

    // Deepest folder with ≥60% of the files under it.
    const counts = new Map<string, number>();
    for (const f of files) {
      let d = dirOf(f);
      for (;;) {
        counts.set(d, (counts.get(d) ?? 0) + 1);
        if (!d) break;
        d = dirOf(d);
      }
    }
    // Folders below the sub-project root, by how many of the files sit under them.
    const ranked = [...counts]
      .filter(([d]) => rel(d) !== "")
      .map(([d, n]) => ({ d, n, depth: d.split("/").length }))
      .sort((a, b) => b.depth - a.depth || b.n - a.n);
    const deepest = (share: number) => ranked.find((x) => x.n >= Math.ceil(files.length * share));
    let name: string;
    let nameBasis: NonNullable<CommunityName["nameBasis"]>;
    // The deepest folder with a real share says most: `mealie/routes (45%)` over `mealie`.
    const pick = deepest(0.35);
    if (pick) {
      const whole = pick.n >= Math.ceil(files.length * 0.6);
      name = whole ? rel(pick.d) : `${rel(pick.d)} (${Math.round((pick.n / files.length) * 100)}%)`;
      nameBasis = whole ? "folder" : "folders";
    } else {
      nameBasis = "folders";
      // Spread wide: the two folders (two levels down) most of it sits in.
      const top = new Map<string, number>();
      for (const f of files) {
        const parts = rel(dirOf(f)).split("/").filter(Boolean).slice(0, 2);
        const key = parts.join("/") || "(top level)";
        top.set(key, (top.get(key) ?? 0) + 1);
      }
      // A real folder names it better than the top level, at the same count.
      const two = [...top].sort((a, b) => b[1] - a[1] || Number(a[0] === "(top level)") - Number(b[0] === "(top level)") || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([k]) => k);
      name = two.join(" + ");
    }
    // Folders that say little: what it serves, then what it stores.
    if (nameBasis === "folders") {
      const members = new Set(files);
      const prefix = dominant((ctx.routes ?? []).filter((r) => r.filePath && members.has(r.filePath) && r.kind !== "frontend").map((r) => routePrefix(r.path)).filter((p) => p !== "/"));
      const entity = prefix ? null : dominant((ctx.access ?? []).filter((a) => members.has(a.file)).map((a) => a.entity));
      if (prefix) [name, nameBasis] = [prefix, "routes"];
      else if (entity) [name, nameBasis] = [entity, "entity"];
    }
    const segs = name.replace(/ \(\d+%\)$/, "").split(" + ")[0]!.split("/").filter(Boolean);
    const subsystem = segs.length ? segs.slice(0, Math.min(2, segs.length)).join("/") : name;
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "top-level";
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    if (n > 1) {
      // Two communities in one folder: tell them apart by the file most of the other files sit beside.
      const lead = [...files].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0]!.split("/").pop()!.replace(/\.\w+$/, "");
      name = `${name} (${lead})`;
      slug = `${slug}-${lead.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    }
    out[id] = { name, slug, subsystem, ...(multiProject && project && project.id !== "root" ? { system: project.name } : {}), nameBasis };
  }

  // The level above: each group named by the same rules over all of its files.
  if (ctx.groups && Object.keys(ctx.groups).length) {
    const groupFiles: Record<string, string[]> = {};
    for (const [id, g] of Object.entries(ctx.groups)) (groupFiles[g] ??= []).push(...(communities[id] ?? []));
    const groupNames = nameCommunities(groupFiles, { ...ctx, groups: undefined, links: undefined, anchors: undefined });
    for (const [id, g] of Object.entries(ctx.groups)) {
      // A group of one community is that community: no level above to name.
      const size = Object.values(ctx.groups).filter((x) => x === g).length;
      if (out[id] && size > 1 && groupNames[g]) out[id]!.group = groupNames[g]!.name;
    }
  }
  if (ctx.links) {
    const of = new Map<string, string>();
    for (const [id, files] of Object.entries(communities)) for (const f of files) of.set(f, id);
    const linked = new Set<string>();
    for (const l of ctx.links) {
      const a = of.get(l.source);
      const b = of.get(l.target);
      if (a && b && a !== b) linked.add(a).add(b);
    }
    for (const [id, files] of Object.entries(communities)) {
      // A one-file community is an isolate, counted as such already.
      if (!out[id] || files.length < 2 || linked.has(id) || files.some((f) => ctx.anchors?.has(f))) continue;
      out[id]!.orphan = true;
    }
  }
  return out;
}
