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
 */

export interface CommunityName {
  name: string;
  slug: string;
  subsystem: string;
  system?: string;
}

const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

export function nameCommunities(
  communities: Readonly<Record<string, readonly string[]>>,
  ctx: { fileProjects?: Readonly<Record<string, string>>; projects?: ReadonlyArray<{ id: string; name: string; root: string }> } = {},
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
    // The deepest folder with a real share says most: `mealie/routes (45%)` over `mealie`.
    const pick = deepest(0.35);
    if (pick) name = pick.n >= Math.ceil(files.length * 0.6) ? rel(pick.d) : `${rel(pick.d)} (${Math.round((pick.n / files.length) * 100)}%)`;
    else {
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
    out[id] = { name, slug, subsystem, ...(multiProject && project && project.id !== "root" ? { system: project.name } : {}) };
  }
  return out;
}
