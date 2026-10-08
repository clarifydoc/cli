import type {
  CallBaseRef,
  CallOrigin,
  DataSourceInfo,
  DeploymentModel,
  FileAnalysis,
  HttpClientRegistration,
  ServiceAddress,
} from "../types/analysis.js";
import type { ImportIndex } from "../types/project.js";
import type { ProjectConfigValue } from "./config-values.js";
import { serviceConfigFor } from "../extractors/registry.js";
import { isLoopbackHost, parseAddress, urlValue } from "./url-values.js";
import { resolveHost } from "./service-addresses.js";

type ApiCall = DataSourceInfo & { filePath: string };
type Evidence = CallOrigin["evidence"][number];

/**
 * Where each outbound call goes — the service it reaches, followed through
 * the facts that state it:
 *
 *   call → base reference   an absolute URL's host; the client the call is
 *                           made through (a typed or named .NET client, an
 *                           axios instance) and the base its registration
 *                           sets; or a base expression the language plugin
 *                           reads (`process.env.ORDERS_URL`, `_config["…"]`)
 *        → values           the deployment env of the service running the
 *                           caller's project (compose/k8s), the project's own
 *                           configuration files (test profiles never), and
 *                           only when neither says anything, the code's
 *                           fallback literal
 *        → host → project   through the service address book.
 *
 * A project is named only when every value that resolves names the same one;
 * values naming two projects decide nothing (AMBIGUOUS). A host no project
 * answers to is `external`. Once the base is known the call's target is made
 * whole — the origin stripped, the base's path prefixed — and `baseExpr` is
 * dropped, so the linker reads a complete path and joins it against the
 * routes of that project only.
 *
 * Language-agnostic: language knowledge arrives as plugin facts
 * (`baseRef`, `httpClientRegistrations`) and through `serviceConfigFor`.
 * Mutates the aggregated rows; returns how many calls got an origin.
 */
export function resolveCallOrigins(input: {
  calls: ApiCall[];
  analyses: readonly FileAnalysis[];
  importIndex: ImportIndex;
  deployment: DeploymentModel | undefined;
  config: ReadonlyMap<string, readonly ProjectConfigValue[]>;
  addresses: readonly ServiceAddress[];
}): number {
  const { calls, analyses, importIndex, deployment, config, addresses } = input;
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));

  const projectRegs = new Map<string, Array<{ reg: HttpClientRegistration; file: string; project: string }>>();
  const fileRegs = new Map<string, HttpClientRegistration[]>();
  for (const a of analyses) {
    for (const reg of a.httpClientRegistrations ?? []) {
      if (reg.scope === "file") (fileRegs.get(a.filePath) ?? fileRegs.set(a.filePath, []).get(a.filePath)!).push(reg);
      else (projectRegs.get(reg.client) ?? projectRegs.set(reg.client, []).get(reg.client)!).push({ reg, file: a.filePath, project: a.projectId });
    }
  }

  /** The registration a call's client names — one base, or none. */
  const registrationOf = (call: ApiCall, project: string): { base: CallBaseRef; evidence: Evidence } | null => {
    if (call.baseRef?.kind === "client") {
      const all = projectRegs.get(call.baseRef.key) ?? [];
      const own = all.filter((r) => r.project === project);
      const pool = own.length ? own : all;
      const bases = new Set(pool.map((r) => JSON.stringify(r.reg.base)));
      if (bases.size !== 1) return null;
      const r = pool[0]!;
      return { base: r.reg.base, evidence: { step: "client", detail: call.baseRef.key, file: r.file, line: r.reg.line } };
    }
    if (!call.client) return null;
    let file = call.filePath;
    let regs = (fileRegs.get(file) ?? []).filter((r) => r.client === call.client);
    if (regs.length === 0) {
      const from = importIndex.localFor(call.filePath, call.client);
      if (!from) return null;
      const theirs = fileRegs.get(from) ?? [];
      // Imported under another name: the source file's one client is the one it exports.
      regs = theirs.filter((r) => r.client === call.client);
      if (regs.length === 0 && theirs.length === 1) regs = theirs;
      file = from;
    }
    if (regs.length !== 1) return null;
    return { base: regs[0]!.base, evidence: { step: "client", detail: call.client, file, line: regs[0]!.line } };
  };

  /**
   * The reference a call's base comes from, first stated fact wins: the URL
   * itself (absolute, or a loopback origin `finalizeApiTargets` recorded),
   * then the client it is made through, then a base expression. `assumed`:
   * the host was never stated (`http://${IP}:5000`) and only the port is read.
   */
  const referenceOf = (call: ApiCall, a: FileAnalysis): { ref: CallBaseRef; evidence: Evidence[]; assumed?: true } | null => {
    const abs = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(call.target ?? "");
    if (abs) return { ref: { kind: "literal", key: abs[1]! }, evidence: [] };
    if (call.baseRef?.kind === "literal") return { ref: call.baseRef, evidence: [] };
    const reg = registrationOf(call, a.projectId);
    if (reg) return { ref: reg.base, evidence: [reg.evidence] };
    if (call.baseRef && call.baseRef.kind !== "client") return { ref: call.baseRef, evidence: [] };
    const hole = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\$\{[^/]*?:(\d{1,5})$/i.exec(call.baseExpr ?? "");
    if (hole) {
      return {
        ref: { kind: "literal", key: `http://localhost:${hole[1]}` },
        evidence: [{ step: "literal", detail: `${call.baseExpr}: host not stated, port ${hole[1]} read as a server on this machine` }],
        assumed: true,
      };
    }
    if (call.baseExpr) {
      const ref = serviceConfigFor(a.language)?.baseRefOf?.(call.baseExpr);
      if (ref) return { ref, evidence: [] };
    }
    if (call.baseEnv) return { ref: { kind: "env", key: call.baseEnv }, evidence: [] };
    return null;
  };

  const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  /** Every value stated for the reference, as seen from the caller's project. */
  const valuesOf = (ref: CallBaseRef, project: string, language: string): Array<{ value: string; evidence: Evidence; fallback?: true }> => {
    if (ref.kind === "literal") return [{ value: ref.key, evidence: { step: "literal", detail: ref.key } }];
    if (ref.kind === "client") return [];
    const envNames = ref.kind === "env" ? [ref.key] : (serviceConfigFor(language)?.envNamesFor?.(ref.key) ?? []);
    const out: Array<{ value: string; evidence: Evidence }> = [];
    for (const s of deployment?.services ?? []) {
      if (s.project !== project) continue;
      for (const [k, v] of Object.entries(s.urlEnv ?? {})) {
        if (envNames.some((n) => sameKey(n, k))) out.push({ value: v, evidence: { step: "env", detail: `${k}=${v}`, file: s.composeFile } });
      }
    }
    for (const c of config.get(project) ?? []) {
      if (c.test || c.listen) continue;
      const hit = c.env ? envNames.some((n) => sameKey(n, c.key)) : ref.kind === "config" && sameKey(c.key, ref.key);
      if (hit) out.push({ value: c.value, evidence: { step: c.env ? "env" : "config", detail: `${c.key}=${c.value}`, file: c.file, ...(c.line ? { line: c.line } : {}) } });
    }
    if (out.length === 0 && ref.fallback) {
      const v = urlValue(ref.fallback);
      if (v) return [{ value: v, evidence: { step: "fallback", detail: v }, fallback: true }];
    }
    return out;
  };

  let resolved = 0;
  for (const call of calls) {
    if (call.kind !== "api-call") continue;
    const a = byFile.get(call.filePath);
    if (!a) continue;
    const found = referenceOf(call, a);
    if (!found) continue;
    const values = valuesOf(found.ref, a.projectId, a.language);
    if (values.length === 0) continue;

    const evidence: Evidence[] = [...found.evidence];
    const projects = new Map<string, { host: string; path: string; via: ServiceAddress }>();
    const outside: Array<{ host: string; origin: string; path: string }> = [];
    /** Hosts several projects answer to: they name none, and veto the rest. */
    let shared = false;
    let unknownLoopback: string | undefined;
    for (const v of values) {
      evidence.push(v.evidence);
      const addr = parseAddress(v.value);
      if (!addr) continue;
      const hostLabel = isLoopbackHost(addr.host) ? `localhost:${addr.port ?? ""}` : addr.host;
      const r = resolveHost(addresses, addr.host, addr.port);
      if (r.kind === "project") {
        const prev = projects.get(r.project);
        // A service name reads better than `localhost:5102` for the same project.
        if (!prev || (prev.host.startsWith("localhost:") && !hostLabel.startsWith("localhost:"))) {
          projects.set(r.project, { host: hostLabel, path: addr.path, via: r.via });
        }
      } else if (r.kind === "unknown" && !isLoopbackHost(addr.host)) {
        const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(v.value)?.[1] ?? `http://${addr.host}`;
        outside.push({ host: addr.host, origin, path: addr.path });
      } else if (r.kind === "unknown") {
        unknownLoopback ??= hostLabel;
      } else {
        shared = true;
      }
    }

    const allFallback = values.every((v) => v.fallback);
    let origin: CallOrigin;
    if (projects.size === 1 && !shared) {
      const [project, hit] = [...projects][0]!;
      evidence.push({ step: "address", detail: `${hit.host} → ${project} (${hit.via.source})`, file: hit.via.file });
      const clean = outside.length === 0 && !unknownLoopback;
      origin = { baseRef: found.ref, host: hit.host, project, confidence: clean && !allFallback && !found.assumed ? "EXTRACTED" : "INFERRED", evidence };
      call.target = rebase(call.target!, hit.path);
      if (call.targetAlternatives) call.targetAlternatives = call.targetAlternatives.map((t) => rebase(t, hit.path));
      delete call.baseExpr;
    } else if (projects.size > 1 || shared) {
      origin = { baseRef: found.ref, confidence: "AMBIGUOUS", evidence };
    } else if (outside.length > 0) {
      const hit = outside[0]!;
      origin = { baseRef: found.ref, host: hit.host, external: true, confidence: allFallback ? "INFERRED" : "EXTRACTED", evidence };
      // Another system's URL: whole and absolute, so it never joins a route here.
      if (call.target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(call.target)) {
        call.target = hit.origin + rebase(call.target, hit.path);
        delete call.baseExpr;
      }
    } else {
      origin = { baseRef: found.ref, ...(unknownLoopback ? { host: unknownLoopback } : {}), confidence: "INFERRED", evidence };
    }
    call.origin = origin;
    resolved++;
  }
  return resolved;
}

/** `target` with any origin stripped and `basePath` in front (once). */
function rebase(target: string, basePath: string): string {
  let t = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  if (!t.startsWith("/")) t = "/" + t;
  if (basePath && t !== basePath && !t.startsWith(basePath + "/")) t = basePath + (t === "/" ? "" : t);
  return t;
}
