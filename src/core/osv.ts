import type { ExternalPackage, PackageEcosystem } from "../types/analysis.js";

/**
 * Known vulnerabilities of the installed packages, from OSV (osv.dev) — the
 * one part of an analysis that goes to the network, so it runs only when
 * asked (`analyze --osv`). Each package with an EXACT version is asked about
 * (`resolvedVersion` from its lockfile, else a declared version that is
 * already exact — never a range's lower bound, which reports advisories the
 * install does not have). Severity is OSV's `database_specific.severity`
 * (GitHub's LOW/MODERATE/HIGH/CRITICAL), not a CVSS vector's number.
 * Failures leave the inventory as it was; they never fail the analysis.
 */

/** Our ecosystems → OSV's names. Those without one are not asked about. */
const OSV_ECOSYSTEM: Partial<Record<PackageEcosystem, string>> = {
  npm: "npm", pypi: "PyPI", cargo: "crates.io", go: "Go", rubygems: "RubyGems", composer: "Packagist",
  nuget: "NuGet", maven: "Maven", gradle: "Maven", pub: "Pub", hex: "Hex", hackage: "Hackage", cran: "CRAN",
};
/** A version that names one release: `4.17.15`, `v1.9.1`, `2.0.0-beta.1`. */
const EXACT = /^v?\d+(?:\.\d+)*(?:[-+.][\w.-]+)?$/;
const BATCH = 1000;
const MAX_DETAILS = 300;
const CONCURRENCY = 8;

/** The parts of an OSV `affected[]` entry read here. */
interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ecosystem_specific?: { imports?: Array<{ path?: string; symbols?: string[] }> };
}

const MAX_FUNCTION_ROWS = 16;
const MAX_FUNCTION_SYMBOLS = 64;

/**
 * The functions an advisory states as vulnerable, for the ecosystems whose records say so: Go's
 * `ecosystem_specific.imports[]` (an import path and its symbols), read only from the entry naming THIS
 * module. Only exported names are kept (`Unmarshal`, `Decoder.Decode`): an unexported symbol is reached
 * through one of them, and no caller writes it. Other ecosystems state none, and stay package-level.
 */
function vulnerableFunctionsOf(pkg: ExternalPackage, affected: OsvAffected[] | undefined): Array<{ path: string; symbols: string[] }> {
  if (pkg.ecosystem !== "go" || !affected) return [];
  const byPath = new Map<string, Set<string>>();
  for (const a of affected) {
    if (a.package?.ecosystem !== "Go" || a.package.name !== pkg.name) continue;
    for (const imp of a.ecosystem_specific?.imports ?? []) {
      if (typeof imp.path !== "string" || !Array.isArray(imp.symbols)) continue;
      const exported = imp.symbols.filter((s): s is string => typeof s === "string" && /^\p{Lu}/u.test(s));
      if (exported.length === 0) continue;
      const set = byPath.get(imp.path) ?? byPath.set(imp.path, new Set()).get(imp.path)!;
      for (const s of exported) set.add(s);
    }
  }
  return [...byPath].slice(0, MAX_FUNCTION_ROWS).map(([path, set]) => ({ path, symbols: [...set].sort().slice(0, MAX_FUNCTION_SYMBOLS) }));
}

export interface OsvOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
}

/** Ask OSV about every package with an exact version; set `advisories` on those it knows. Returns how many got one. */
export async function attachOsvAdvisories(packages: ExternalPackage[], opts: OsvOptions = {}): Promise<{ asked: number; vulnerable: number; error?: string }> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.endpoint ?? "https://api.osv.dev").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 20000;
  const asked = packages.flatMap((p) => {
    // This repository's own package: no registry holds its advisories.
    if (p.local !== undefined) return [];
    const ecosystem = OSV_ECOSYSTEM[p.ecosystem];
    const version = p.resolvedVersion ?? (p.version && EXACT.test(p.version.trim()) ? p.version.trim() : null);
    // Maven coordinates must be group:artifact.
    if (!ecosystem || !version || (ecosystem === "Maven" && !p.name.includes(":"))) return [];
    return [{ pkg: p, query: { package: { name: p.name, ecosystem }, version: version.replace(/^v(?=\d)/, ecosystem === "Go" ? "v" : "") } }];
  });
  if (asked.length === 0) return { asked: 0, vulnerable: 0 };

  const post = async (url: string, body: unknown): Promise<unknown> => {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`OSV ${res.status}`);
    return res.json();
  };
  try {
    const ids = new Map<ExternalPackage, string[]>();
    for (let i = 0; i < asked.length; i += BATCH) {
      const chunk = asked.slice(i, i + BATCH);
      const out = (await post(`${base}/v1/querybatch`, { queries: chunk.map((c) => c.query) })) as { results?: Array<{ vulns?: Array<{ id: string }> }> };
      (out.results ?? []).forEach((r, k) => {
        const list = (r.vulns ?? []).map((v) => v.id);
        if (list.length) ids.set(chunk[k]!.pkg, list);
      });
    }
    // Details (summary, severity, aliases) for the advisories found, capped.
    const unique = [...new Set([...ids.values()].flat())].sort().slice(0, MAX_DETAILS);
    const details = new Map<string, { summary?: string; severity?: string; aliases?: string[]; affected?: OsvAffected[] }>();
    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      await Promise.all(unique.slice(i, i + CONCURRENCY).map(async (id) => {
        try {
          const res = await doFetch(`${base}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) return;
          const v = (await res.json()) as { summary?: string; aliases?: string[]; database_specific?: { severity?: string }; affected?: OsvAffected[] };
          details.set(id, {
            ...(v.summary ? { summary: v.summary } : {}),
            ...(typeof v.database_specific?.severity === "string" ? { severity: v.database_specific.severity.toUpperCase() } : {}),
            ...(v.aliases?.length ? { aliases: v.aliases } : {}),
            ...(Array.isArray(v.affected) ? { affected: v.affected } : {}),
          });
        } catch {
          // One advisory's details missing still leaves its id.
        }
      }));
    }
    for (const [pkg, list] of ids) {
      pkg.advisories = list.map((id) => {
        const { affected, ...rest } = details.get(id) ?? {};
        const functions = vulnerableFunctionsOf(pkg, affected);
        return { id, ...rest, ...(functions.length ? { functions } : {}) };
      });
    }
    return { asked: asked.length, vulnerable: ids.size };
  } catch (e) {
    return { asked: asked.length, vulnerable: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
