import type { FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

/** What a module-level binding is initialized from when it is an HTTP client instance (`localTypes[].from`). */
const CLIENT_FACTORY_FROM = /^(?:axios|ky|got|wretch|ofetch)\.(?:create|extend)\(\)$/;

/**
 * Requests made on a client instance another module builds.
 *
 * `clubAPI.post('auth/sign_in')` with `import clubAPI from './apiClient'`
 * says nothing about HTTP in its own file, so the per-file pass keeps the row
 * as `clientUnconfirmed`. It is a request when the module it is imported
 * from binds that export to an HTTP client instance (`const clubAPI =
 * axios.create({ baseURL })`, exported as is or as the default) — the same
 * fact a call on a local instance rests on, read across the import. The flag
 * goes, and the call keeps `client`, so the client's base applies to it like
 * to a local instance's. Any other row is dropped, here and from its file.
 *
 * Mutates `calls` and the files' rows in place; returns how many were confirmed.
 */
export function confirmImportedClients(calls: ProjectApiCall[], ctx: ProjectContext): number {
  const memo = new Map<string, boolean>();
  let confirmed = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (!call.clientUnconfirmed) continue;
    const analysis = ctx.fileOf(call.filePath);
    const key = `${call.filePath}\0${call.client ?? ""}`;
    let ok = memo.get(key);
    if (ok === undefined) {
      ok = !!analysis && !!call.client && importsClientInstance(analysis, call.client, ctx);
      memo.set(key, ok);
    }
    const row = analysis?.dataSources.findIndex((r) =>
      r.clientUnconfirmed && r.kind === "api-call" && r.line === call.line && r.name === call.name && r.client === call.client && r.target === call.target) ?? -1;
    if (ok) {
      delete call.clientUnconfirmed;
      if (row >= 0) delete analysis!.dataSources[row]!.clientUnconfirmed;
      confirmed++;
    } else {
      calls.splice(i, 1);
      if (row >= 0) analysis!.dataSources.splice(row, 1);
    }
  }
  return confirmed;
}

/** Whether `local`, as `importer` imports it, is a binding its module initializes to an HTTP client instance. */
function importsClientInstance(importer: FileAnalysis, local: string, ctx: ProjectContext): boolean {
  const from = ctx.importIndex.localFor(importer.filePath, local);
  const source = from ? ctx.fileOf(from) : undefined;
  if (!source) return false;
  const imp = importer.imports.find((i) => !i.isType && !i.isNamespace && i.specifiers.includes(local));
  if (!imp) return false;
  const exported = imp.aliases?.[local] ?? (imp.isDefault && imp.specifiers[0] === local ? "default" : local);
  const exp = source.exports.find((e) => e.name === exported && !e.source);
  if (!exp) return false;
  const binding = exp.sourceName ?? exp.name;
  if (source.httpClientBases?.[binding] !== undefined) return true;
  if (source.httpClientRegistrations?.some((r) => r.client === binding && !r.proxyOf)) return true;
  const setup = source.functions.find((f) => f.name === "<setup>");
  return !!setup?.localTypes?.some((l) => l.name === binding && CLIENT_FACTORY_FROM.test(l.from ?? ""));
}
