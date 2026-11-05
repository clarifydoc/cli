import type { FileAnalysis } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { RUST_NEST_FACT, type RustNestFacts } from "./routes.js";
import { moduleOf, resolvePath } from "./rocket-mounts.js";

/**
 * axum `.nest("/api", api::routes())` and actix `.configure(routes::cfg)` whose
 * callee lives in another file. Per file the plugin reports the nests and
 * configures (with the scope prefix they sit under), the fn each route line is
 * declared in and the `use` renames; this pass resolves each callee path to a
 * module and prefixes the routes of that fn — chained, so a nest inside a
 * nested fn composes. Same-file callees were composed per file already.
 */
export const rustNestResolver: RouteResolver = {
  id: "rust-nests",
  languages: ["rust"],
  priority: 46,
  resolve(analyses: FileAnalysis[]): void {
    interface Entry { file: FileAnalysis; facts: RustNestFacts; module: string }
    const byModule = new Map<string, Entry>();
    const entries: Entry[] = [];
    for (const a of analyses) {
      const facts = a.routeFacts?.find((r) => r.kind === RUST_NEST_FACT)?.data as RustNestFacts | undefined;
      if (!facts) continue;
      const e = { file: a, facts, module: moduleOf(a.filePath) };
      byModule.set(e.module, e);
      entries.push(e);
    }
    if (!entries.some((e) => e.facts.calls.length > 0)) return;

    const localOf = (e: Entry, fn: string) => e.facts.local.find((l) => l.fn === fn);
    /** The outermost fn a same-file nest chain reaches, and the prefix that chain adds. */
    const rootOf = (e: Entry, fn: string): { root: string; prefix: string } => {
      let root = fn;
      let prefix = "";
      const seen = new Set<string>();
      for (let n = localOf(e, root); n && !seen.has(root); n = localOf(e, root)) {
        seen.add(root);
        prefix = n.prefix + prefix;
        root = n.owner;
      }
      return { root, prefix };
    };
    const knows = (e: Entry, fn: string): boolean =>
      Object.values(e.facts.owners).includes(fn) || e.facts.local.some((l) => l.fn === fn || l.owner === fn) || e.facts.calls.some((c) => c.owner === fn);

    /** The (file, fn) a callee path names from `from`, when it is a fn that file's facts know. */
    const target = (callee: string, from: Entry): { entry: Entry; fn: string } | null => {
      const segs = callee.split("::");
      const head = from.facts.uses[segs[0]!];
      const written = head ? [...head.split("::"), ...segs.slice(1)].join("::") : callee;
      const candidates = new Set([resolvePath(written, from.module), written.replace(/^crate::/, "")]);
      const hits: Array<{ entry: Entry; fn: string }> = [];
      for (const c of candidates) {
        const parts = c.split("::");
        const fn = parts.pop()!;
        const entry = byModule.get(parts.join("::"));
        if (entry && entry !== from && knows(entry, fn) && !hits.some((h) => h.entry === entry)) hits.push({ entry, fn });
      }
      return hits.length === 1 ? hits[0]! : null;
    };

    /** Every nest naming one (file, root fn): `file\0fn` → distinct prefixes with the nest that carries them. */
    const incoming = new Map<string, Array<{ prefix: string; from: Entry; owner: string }>>();
    for (const e of entries) {
      for (const call of e.facts.calls) {
        const t = target(call.callee, e);
        if (!t || localOf(t.entry, t.fn)) continue; // a fn a same-file nest also names is left to that nest
        const key = `${t.entry.file.filePath}\0${t.fn}`;
        const list = incoming.get(key) ?? incoming.set(key, []).get(key)!;
        list.push({ prefix: call.prefix, from: e, owner: call.owner });
      }
    }

    const totalFor = (e: Entry, root: string, depth = 0): string => {
      if (depth > 8) return "";
      const list = incoming.get(`${e.file.filePath}\0${root}`);
      if (!list || new Set(list.map((l) => l.prefix + "\0" + l.from.file.filePath + l.owner)).size > 1) return "";
      const n = list[0]!;
      const up = rootOf(n.from, n.owner);
      return totalFor(n.from, up.root, depth + 1) + up.prefix + n.prefix;
    };

    for (const e of entries) {
      e.file.routes = e.file.routes.map((r) => {
        const owner = e.facts.owners[r.line ?? 0];
        if (owner === undefined || owner === "") return r;
        const add = totalFor(e, rootOf(e, owner).root);
        if (!add) return r;
        return { ...r, path: `${add.replace(/\/+$/, "")}/${r.path.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/" };
      });
    }
  },
};
