import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { HUMA_AUTOPATCH_FACT, HUMA_OWNER, HUMA_SERVER_FACT, type HumaServerFact } from "./huma.js";

/**
 * Huma operations, given the base their API is served under (see huma.ts).
 *
 * The base is the path of the OpenAPI server URL the project declares
 * (`huma.Server{URL: GroupPrefix}`), a constant one file names and another
 * defines. One base for the whole project → every operation gets it. None
 * declared → the paths are already complete (an API on the root router).
 * Several, or one no file can evaluate → the rows keep `prefixUnresolved`, and
 * the linker matches them only as suffixes.
 *
 * With `autopatch.AutoPatch(api)` anywhere in the project, every operation path
 * that has a GET and a PUT also answers PATCH: Huma synthesizes it as a GET,
 * a merge, then the PUT, so the row anchors on the PUT's registration.
 */
export const humaBaseResolver: RouteResolver = {
  id: "huma-base",
  languages: ["go"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    const huma = analyses.filter((a) => a.routes.some((r) => r.owner === HUMA_OWNER));
    if (huma.length === 0) return;

    const servers: HumaServerFact[] = [];
    let autopatch = false;
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === HUMA_SERVER_FACT) servers.push(f.data as HumaServerFact);
        else if (f.kind === HUMA_AUTOPATCH_FACT) autopatch = true;
      }
    }
    // A constant one file cannot see, another file evaluated under the same name.
    const byName = new Map<string, Set<string>>();
    for (const s of servers) if (s.name && s.path !== null) (byName.get(s.name) ?? byName.set(s.name, new Set()).get(s.name)!).add(s.path);
    const bases = new Set<string>();
    let unknown = false;
    for (const s of servers) {
      const named = s.path === null && s.name ? byName.get(s.name) : undefined;
      if (s.path !== null) bases.add(s.path);
      else if (named?.size === 1) bases.add([...named][0]!);
      else unknown = true;
    }
    const settled = !unknown && bases.size <= 1;
    const base = settled ? ([...bases][0] ?? "") : null;

    for (const a of huma) {
      const rows = a.routes.map((r) => (r.owner === HUMA_OWNER && base !== null ? withBase(r, base) : r));
      if (autopatch) rows.push(...autoPatches(rows.filter((r) => r.owner === HUMA_OWNER)));
      a.routes = rows;
    }
  },
};

function withBase(r: RouteInfo, base: string): RouteInfo {
  const { prefixUnresolved: _, ...rest } = r;
  return { ...rest, path: base + r.path };
}

/** A PATCH beside every GET + PUT pair the file registers (AutoPatch skips paths that declare their own PATCH). */
function autoPatches(rows: RouteInfo[]): RouteInfo[] {
  const byPath = new Map<string, Map<string, RouteInfo>>();
  for (const r of rows) {
    const m = byPath.get(r.path) ?? byPath.set(r.path, new Map()).get(r.path)!;
    if (r.httpMethod) m.set(r.httpMethod, r);
  }
  const out: RouteInfo[] = [];
  for (const methods of byPath.values()) {
    const put = methods.get("PUT");
    if (put && methods.has("GET") && !methods.has("PATCH")) out.push({ ...put, httpMethod: "PATCH" });
  }
  return out;
}
