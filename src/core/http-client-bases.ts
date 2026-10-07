import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";
import type { ImportIndex } from "./import-index.js";

/**
 * Prepend a client instance's base URL to the api-calls made through it.
 *
 * `apiClient.get("/users")` on `const apiClient = axios.create({ baseURL:
 * "/api" })` requests `/api/users`; the call site only spells `/users`. Left
 * as is, the route join had to GUESS a base — and once a service really
 * serving `/users` appeared, it bound the call to the wrong backend. The
 * client's base is a stated fact (`FileAnalysis.httpClientBases`, in the
 * calling file or the one `client` is imported from), so it is applied before
 * the join. A target that is not app-relative (`https://…`) or already
 * carries the base is left alone.
 *
 * Mutates the aggregated api-call rows in place; returns how many changed.
 */
export function applyHttpClientBases(
  apiCalls: Array<DataSourceInfo & { filePath: string }>,
  analyses: FileAnalysis[],
  importIndex: ImportIndex,
): number {
  const bases = new Map<string, Record<string, string>>();
  for (const a of analyses) if (a.httpClientBases) bases.set(a.filePath, a.httpClientBases);
  if (bases.size === 0) return 0;

  const baseFor = (file: string, client: string): string | null => {
    const own = bases.get(file)?.[client];
    if (own !== undefined) return own;
    const from = importIndex.localFor(file, client);
    if (!from) return null;
    const theirs = bases.get(from);
    if (!theirs) return null;
    if (theirs[client] !== undefined) return theirs[client]!;
    // Imported under another name (a default export bound as `api`): the
    // source file's one client is the one it exports.
    const only = Object.values(theirs);
    return only.length === 1 ? only[0]! : null;
  };

  const apply = (target: string, base: string): string =>
    !base || !target.startsWith("/") || target === base || target.startsWith(base + "/") ? target : base + target;

  let changed = 0;
  for (const call of apiCalls) {
    if (call.kind !== "api-call" || !call.client || !call.target) continue;
    const base = baseFor(call.filePath, call.client);
    if (base === null) continue;
    // A relative path (`session`) was relative to exactly this base: once it
    // is known, the base is no longer unknown.
    if (call.baseExpr === "") delete call.baseExpr;
    const target = apply(call.target, base);
    if (target === call.target) continue;
    call.target = target;
    if (call.targetAlternatives) call.targetAlternatives = call.targetAlternatives.map((t) => apply(t, base));
    changed++;
  }
  return changed;
}
