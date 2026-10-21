import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/**
 * Rocket's mounts: an attribute route (`#[get("/folders")]`) is served under
 * the base its `routes![…]` list is mounted at, wherever that is —
 *
 *   rocket::build().mount("/api", api::core_routes())        // main.rs
 *   pub use crate::api::{ core::routes as core_routes };     // api/mod.rs
 *   pub fn routes() -> Vec<Route> {                          // api/core/mod.rs
 *       let mut routes = routes![config, version];
 *       routes.append(&mut folders::routes());               // api/core/folders.rs
 *       routes
 *   }
 *
 * Per file the plugin reports the mounts, the route functions (the handlers
 * their `routes!` lists name and the route functions they append) and the
 * `pub use … as …` renames; this pass follows each mount through them, module
 * by module, and prefixes the routes of every handler it reaches. A base
 * spelled `[basepath, "/api"].concat()` is its literal part.
 */
export const ROCKET_FACT = "rust:rocket";

interface RocketFacts {
  mounts: Array<{ base: string; fn: string; line: number }>;
  routeFns: Array<{ name: string; handlers: string[]; includes: string[] }>;
  aliases: Array<{ alias: string; path: string }>;
}

const MOUNT_RE = /\.mount\s*\(\s*(?:"([^"]*)"|\[([^\]]*)\]\s*\.\s*concat\s*\(\s*\))\s*,\s*((?:\w+::)*\w+)\s*\(\s*\)/g;
const ROUTE_FN_RE = /\bfn\s+(\w+)\s*\(\s*\)\s*->\s*Vec\s*<\s*(?:rocket::)?Route\s*>\s*\{/g;

/** Per file: the mounts, route functions and renames, as one route fact. */
export function collectRocketFacts(lines: string[], facts: RouteFact[] | undefined): void {
  if (!facts) return;
  const text = lines.join("\n");
  if (!text.includes("routes!") && !text.includes(".mount(") && !/\bas\s+\w*routes\b/.test(text)) return;
  const out: RocketFacts = { mounts: [], routeFns: [], aliases: [] };
  for (const m of text.matchAll(MOUNT_RE)) {
    const base = m[1] ?? [...(m[2] ?? "").matchAll(/"([^"]*)"/g)].map((s) => s[1]).join("");
    out.mounts.push({ base, fn: m[3]!, line: text.slice(0, m.index!).split("\n").length });
  }
  for (const m of text.matchAll(ROUTE_FN_RE)) {
    const body = blockAt(text, m.index! + m[0].length - 1);
    const handlers = [...body.matchAll(/\broutes!\s*\[([^\]]*)\]/g)].flatMap((r) => r[1]!.split(",").map((h) => h.trim().split("::").pop()!).filter(Boolean));
    const includes = [...body.matchAll(/\b((?:\w+::)*\w+)\s*\(\s*\)/g)].map((c) => c[1]!).filter((c) => /(?:^|::)\w*routes$/.test(c) && c !== m[1]);
    out.routeFns.push({ name: m[1]!, handlers, includes });
  }
  for (const use of text.matchAll(/\bpub\s+use\s+([^;]+);/g)) {
    for (const a of use[1]!.matchAll(/((?:\w+::)*\w+)\s+as\s+(\w+)/g)) {
      const full = qualify(use[1]!, a.index!) + a[1]!;
      out.aliases.push({ alias: a[2]!, path: full });
    }
  }
  if (out.mounts.length || out.routeFns.length || out.aliases.length) facts.push({ kind: ROCKET_FACT, line: 1, data: out });
}

/** The `{ … }` block whose `{` is at `open`. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The path prefix in front of a nested `use a::{ b::c as d }` item at `at`: `a::`. */
function qualify(useBody: string, at: number): string {
  const before = useBody.slice(0, at);
  const open = before.lastIndexOf("{");
  if (open < 0) return "";
  const head = /((?:\w+::)*)\s*$/.exec(before.slice(0, open))?.[1] ?? "";
  return head;
}

/** A Rust file's module path: `src/api/core/folders.rs` → api::core::folders; `mod.rs`, `main.rs`, `lib.rs` are their directory. */
function moduleOf(filePath: string): string {
  const rel = filePath.replace(/^(?:.*\/)?src\//, "");
  const segs = rel.replace(/\.rs$/, "").split("/");
  if (["mod", "main", "lib"].includes(segs[segs.length - 1]!)) segs.pop();
  return segs.join("::");
}

/** `crate::a::b`, `self::b`, `super::b` and a bare `b` from module `from`, as a module path. */
function resolvePath(path: string, from: string): string {
  const segs = path.split("::");
  if (segs[0] === "crate") return segs.slice(1).join("::");
  const base = from ? from.split("::") : [];
  if (segs[0] === "self") return [...base, ...segs.slice(1)].join("::");
  let up = 0;
  while (segs[up] === "super") up++;
  if (up > 0) return [...base.slice(0, base.length - up), ...segs.slice(up)].join("::");
  return [...base, ...segs].join("::");
}

export const rocketMountResolver: RouteResolver = {
  id: "rocket-mounts",
  languages: ["rust"],
  priority: 45,
  resolve(analyses: FileAnalysis[]): void {
    const byModule = new Map<string, { file: FileAnalysis; facts: RocketFacts }>();
    for (const a of analyses) {
      const f = a.routeFacts?.find((r) => r.kind === ROCKET_FACT)?.data as RocketFacts | undefined;
      byModule.set(moduleOf(a.filePath), { file: a, facts: f ?? { mounts: [], routeFns: [], aliases: [] } });
    }
    const mounts = analyses.flatMap((a) => (a.routeFacts?.find((r) => r.kind === ROCKET_FACT)?.data as RocketFacts | undefined)?.mounts.map((m) => ({ ...m, from: moduleOf(a.filePath) })) ?? []);
    if (mounts.length === 0) return;

    /** The route function a path names from module `from`, through `pub use … as …` renames. */
    const routeFnAt = (path: string, from: string, depth = 0): { module: string; name: string } | null => {
      if (depth > 6) return null;
      const full = resolvePath(path, from);
      const segs = full.split("::");
      const name = segs.pop()!;
      const module = segs.join("::");
      const mod = byModule.get(module);
      if (!mod) return null;
      if (mod.facts.routeFns.some((r) => r.name === name)) return { module, name };
      const alias = mod.facts.aliases.find((a) => a.alias === name);
      return alias ? routeFnAt(alias.path, module, depth + 1) : null;
    };

    const prefixes = new Map<string, Map<string, string>>(); // file → handler → base
    for (const mount of mounts) {
      const seen = new Set<string>();
      const visit = (fn: { module: string; name: string } | null): void => {
        if (!fn || seen.has(`${fn.module}#${fn.name}`)) return;
        seen.add(`${fn.module}#${fn.name}`);
        const mod = byModule.get(fn.module)!;
        const routeFn = mod.facts.routeFns.find((r) => r.name === fn.name)!;
        const handlers = prefixes.get(mod.file.filePath) ?? prefixes.set(mod.file.filePath, new Map()).get(mod.file.filePath)!;
        for (const h of routeFn.handlers) if (!handlers.has(h)) handlers.set(h, mount.base);
        for (const inc of routeFn.includes) visit(routeFnAt(inc, fn.module));
      };
      visit(routeFnAt(mount.fn, mount.from));
    }

    for (const a of analyses) {
      const handlers = prefixes.get(a.filePath);
      if (!handlers) continue;
      a.routes = a.routes.map((r) => {
        const base = r.kind === "api" && r.handler ? handlers.get(r.handler) : undefined;
        if (base === undefined || base === "" || base === "/") return r;
        return { ...r, path: `${base.replace(/\/+$/, "")}/${r.path.replace(/^\/+/, "")}`.replace(/\/$/, "") || "/" };
      });
    }
  },
};
