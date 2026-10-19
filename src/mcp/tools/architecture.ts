import { byOrdinal } from "../../core/ordinal.js";
import { findCircularDeps } from "../../core/health-scorer.js";
import { runtimeGraph } from "../../core/import-kinds.js";
import type { McpTool } from "../protocol.js";
import { bulletList, contains, enumArg, joinLines, numberArg, plural, stringArg } from "../format.js";
import { noResults } from "../empty.js";
import { projectName, requireAnalysis, type ToolContext } from "./context.js";

const VIEWS = ["overview", "modules", "communities", "hubs", "cycles", "surprises", "questions", "cochange"] as const;
type View = (typeof VIEWS)[number];

/**
 * The project's shape, from the graphs the analysis already holds: folders
 * and how they depend on one another (with instability), the communities the
 * import graph falls into, its hub files, import cycles, cross-community
 * surprises, the questions the topology raises, and files that change
 * together in history. Every view is a list with `path:line`-free file paths
 * and a cap; `file` narrows to rows that name a file.
 */
export function architectureTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_architecture",
    title: "Architecture: modules, communities, hubs, cycles",
    description:
      "The project's structure from its import graph and history. view=modules: folders (at `depth`) and the " +
      "dependencies between them, each with afferent/efferent coupling and instability (Ce/(Ca+Ce)). " +
      "view=communities: the clusters the import graph falls into, with cohesion. view=hubs: the most connected " +
      "files. view=cycles: import cycles. view=surprises: links between communities, or to a hub from the " +
      "periphery, worth a second look. view=questions: what the topology suggests asking. view=cochange: files " +
      "that change together in git history, marked when no import explains it. Omit `view` for the overview. " +
      "Use it to orient in a codebase before reading files, and to see where a change sits structurally.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: [...VIEWS], description: "Which view; default overview." },
        file: { type: "string", description: "Only rows naming this file or folder (project-relative substring)." },
        depth: { type: "number", description: "view=modules: folder depth to group by (default 2)." },
        limit: { type: "number", description: "Max rows (default 25)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const { summary } = await requireAnalysis(ctx);
      const view: View = enumArg(args, "view", VIEWS) ?? "overview";
      const file = stringArg(args, "file");
      const limit = numberArg(args, "limit", 25, { max: 300 });
      const graph = summary.componentGraph ?? {};
      const communities = Object.entries(summary.communities ?? {});
      const cohesion = summary.cohesion ?? {};
      const names = (fs: readonly string[]) => (file ? fs.some((f) => contains(f, file)) : true);

      const order = (a: string[], b: string[]) => a.length - b.length || byOrdinal(a[0] ?? "", b[0] ?? "");
      // Runtime cycles; a cycle only type imports close is listed apart, never counted.
      const cycles = () => findCircularDeps(runtimeGraph(graph, summary.typeOnlyEdges)).filter(names).sort(order);
      const typeOnlyCycles = () => {
        const runtime = new Set(cycles().map((c) => [...c].sort().join("\u0000")));
        return findCircularDeps(graph).filter(names).filter((c) => !runtime.has([...c].sort().join("\u0000"))).sort(order);
      };

      switch (view) {
        case "overview": {
          const cyc = cycles();
          const largest = communities.slice(0, 5);
          return {
            text: joinLines([
              `# Architecture — ${projectName(summary)}`,
              `${plural(summary.files.length, "file")}, ${plural(Object.values(graph).reduce((n, d) => n + d.length, 0), "import edge")}, ${plural(communities.length, "community", "communities")}, ${plural(cyc.length, "import cycle")}.`,
              "",
              "## Largest communities",
              ...bulletList(largest, 5, ([id, fs]) => `${summary.communityNames?.[id]?.name ?? id}: ${plural(fs.length, "file")}${cohesion[id] !== undefined ? `, cohesion ${cohesion[id]!.toFixed(2)}` : ""} — e.g. ${fs.slice(0, 3).join(", ")}`),
              "",
              "## Hubs",
              ...bulletList(summary.godNodes ?? [], 5, (g) => `${g.file} (degree ${g.degree})`),
              "",
              `Next: view="modules" for folder-level dependencies, "cycles", "surprises", "cochange".`,
            ]),
          };
        }
        case "modules": {
          const depth = Math.max(1, Math.min(6, numberArg(args, "depth", 2, { max: 6 })));
          const moduleOf = (f: string) => {
            const parts = f.split("/");
            return parts.length <= 1 ? "(root)" : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
          };
          const edges = new Map<string, number>();
          const files = new Map<string, number>();
          for (const f of summary.files) files.set(moduleOf(f), (files.get(moduleOf(f)) ?? 0) + 1);
          for (const [from, deps] of Object.entries(graph)) {
            const a = moduleOf(from);
            for (const d of deps) {
              const b = moduleOf(d);
              if (a !== b) edges.set(`${a}\u0000${b}`, (edges.get(`${a}\u0000${b}`) ?? 0) + 1);
            }
          }
          const ca = new Map<string, Set<string>>();
          const ce = new Map<string, Set<string>>();
          for (const key of edges.keys()) {
            const [a, b] = key.split("\u0000") as [string, string];
            (ce.get(a) ?? ce.set(a, new Set()).get(a)!).add(b);
            (ca.get(b) ?? ca.set(b, new Set()).get(b)!).add(a);
          }
          const rows = [...files.keys()]
            .filter((m) => !file || contains(m, file))
            .map((m) => {
              const inn = ca.get(m)?.size ?? 0;
              const out = ce.get(m)?.size ?? 0;
              return { m, files: files.get(m)!, inn, out, instability: inn + out === 0 ? 0 : out / (inn + out) };
            })
            .sort((a, b) => b.files - a.files || byOrdinal(a.m, b.m));
          const edgeRows = [...edges.entries()]
            .map(([k, n]) => ({ a: k.split("\u0000")[0]!, b: k.split("\u0000")[1]!, n }))
            .filter((e) => !file || contains(e.a, file) || contains(e.b, file))
            .sort((x, y) => y.n - x.n || byOrdinal(x.a, y.a));
          return {
            text: joinLines([
              `# Modules (folders at depth ${depth})`,
              "Ca = folders that depend on it, Ce = folders it depends on, instability Ce/(Ca+Ce): 0 is stable (many depend on it), 1 is unstable.",
              ...bulletList(rows, limit, (r) => `${r.m} — ${plural(r.files, "file")}, Ca ${r.inn}, Ce ${r.out}, instability ${r.instability.toFixed(2)}`),
              "",
              `## Dependencies between them (${edgeRows.length})`,
              ...bulletList(edgeRows, limit, (e) => `${e.a} → ${e.b} (${plural(e.n, "import")})`),
            ]),
          };
        }
        case "communities": {
          const rows = communities.filter(([, fs]) => names(fs));
          if (rows.length === 0) return { text: noResults({ headline: "No community matches.", holds: `${plural(communities.length, "community", "communities")} in the analysis.`, next: ['clarifydoc_architecture view="communities" without `file`'] }) };
          const named = summary.communityNames ?? {};
          const label = (id: string) => {
            const n = named[id];
            return n ? `${n.name}${n.system ? ` [${n.system}]` : ""}` : `#${id}`;
          };
          // A one-file community is an isolate, not a cluster: counted, not listed.
          const clusters = rows.filter(([, fs]) => fs.length > 1).sort((a, b) => b[1].length - a[1].length);
          const isolates = rows.length - clusters.length;
          const groupOf = (id: string) => {
            const n = named[id];
            return n && !n.name.startsWith(n.subsystem) ? ` (in ${n.system ? `${n.system} / ` : ""}${n.subsystem})` : "";
          };
          return {
            text: joinLines([
              `# Communities (${rows.length - isolates} of two or more files)`,
              "Clusters of files more connected to each other than to the rest (Louvain over the import graph), named by the folder most of their files share.",
              ...bulletList(clusters, limit, ([id, fs]) => `${label(id)}${groupOf(id)}: ${plural(fs.length, "file")}${cohesion[id] !== undefined ? `, cohesion ${cohesion[id]!.toFixed(2)}` : ""} — ${fs.slice(0, 6).join(", ")}${fs.length > 6 ? ` … +${fs.length - 6}` : ""}`),
              isolates ? `${plural(isolates, "file")} with no import ties are communities of one, not listed.` : "",
            ]),
          };
        }
        case "hubs": {
          const rows = (summary.godNodes ?? []).filter((g) => !file || contains(g.file, file));
          return { text: joinLines([`# Hub files (${rows.length})`, "The most connected files (imports in + out): changes here travel far.", ...bulletList(rows, limit, (g) => `${g.file} (degree ${g.degree})`)]) };
        }
        case "cycles": {
          const rows = cycles();
          const typeOnly = typeOnlyCycles();
          const typeLines = typeOnly.length
            ? ["", `## Through type-only imports (${typeOnly.length})`, "Closed only by `import type`: no runtime cycle, not counted.", ...bulletList(typeOnly, limit, (c) => `${c.join(" → ")} → ${c[0]}`)]
            : [];
          if (rows.length === 0 && typeOnly.length === 0) return { text: noResults({ headline: file ? "No import cycle names that file." : "No import cycles.", holds: `${plural(Object.keys(graph).length, "file")} with imports.`, next: [] }) };
          return { text: joinLines([`# Import cycles (${rows.length})`, ...bulletList(rows, limit, (c) => `${c.join(" → ")} → ${c[0]}`), ...typeLines]) };
        }
        case "surprises": {
          const rows = (summary.surprisingConnections ?? []).filter((s) => !file || contains(s.source, file) || contains(s.target, file));
          return { text: joinLines([`# Surprising connections (${rows.length})`, ...bulletList(rows, limit, (s) => `${s.source} → ${s.target} — ${s.reason}${s.confidence ? ` (${s.confidence.toLowerCase()})` : ""}`)]) };
        }
        case "questions": {
          const rows = summary.suggestedQuestions ?? [];
          return { text: joinLines([`# Questions the structure raises (${rows.length})`, ...bulletList(rows, limit, (q) => `${q.question} — ${q.why}`)]) };
        }
        case "cochange": {
          const pairs = (summary.coChange ?? []).filter((p) => !file || contains(p.a, file) || contains(p.b, file));
          if (pairs.length === 0) {
            return { text: noResults({ headline: summary.coChange ? "No co-change pair names that file." : "No co-change data: the analysis ran without git history.", holds: `${plural(summary.coChange?.length ?? 0, "pair")} in the analysis.`, next: summary.coChange ? ['clarifydoc_architecture view="cochange" without `file`'] : ["clarifydoc_analyze (in a git checkout with history)"] }) };
          }
          return {
            text: joinLines([
              `# Files that change together (${pairs.length})`,
              "From git history: committed together in ≥3 small commits, in ≥30% of the less-changed file's commits. \"no import\" marks coupling the code does not show.",
              ...bulletList(pairs, limit, (p) => `${p.a} ⇄ ${p.b} — ${p.count} commits, ${Math.round(p.score * 100)}%${p.hidden ? ", no import" : ""}`),
            ]),
          };
        }
      }
    },
  };
}
