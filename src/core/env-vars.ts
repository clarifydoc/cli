import type { DeploymentModel, FileAnalysis } from "../types/analysis.js";

/**
 * Environment variables as edges between deployment and code: each variable
 * the code reads (`process.env.ORDERS_URL`, `os.getenv("DATABASE_URL")`,
 * `System.getenv("X")`, `Environment.GetEnvironmentVariable("X")`), where it
 * is read, and which deployed services set it — compose `environment:`,
 * Kubernetes `env:`, a Dockerfile's `ENV` (`DeployedService.envKeys`).
 *
 * A setter counts only for a reader in the project the service runs (or a
 * service whose project is unknown): `PORT` set on the orders container says
 * nothing about the billing code that reads `PORT`. A variable read but set
 * by no manifest has no setters — perhaps a `.env` file (never read), perhaps
 * a gap. Names only; values never leave the manifests.
 */

export interface EnvVarUse {
  name: string;
  readBy: Array<{ file: string; line: number; project?: string }>;
  setBy: Array<{ service: string; file: string }>;
}

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Readers that take a variable name (the plugin's `name` is the reader, `target` the variable). */
const READER = /getenv|environ|GetEnvironmentVariable|env::var|env\.get|Deno\.env|os\.Getenv|LookupEnv|ENV\b|getEnv|System\/getenv/i;

/** The variable an `env` data source reads, or null when it is not an environment variable. */
export function envVarName(ds: { name: string; target: string | null }): string | null {
  if (VAR.test(ds.name) && ds.name === ds.name.toUpperCase()) return ds.name;
  const t = (ds.target ?? "").replace(/^(?:process\.env|import\.meta\.env|Deno\.env)\./, "");
  if (VAR.test(t) && (READER.test(ds.name) || /^(?:process\.env|import\.meta\.env)\./.test(ds.target ?? ""))) return t;
  return null;
}

export function joinEnvVars(
  analyses: readonly FileAnalysis[],
  deployment: DeploymentModel | undefined,
  isAuthored: (file: string) => boolean,
): EnvVarUse[] {
  const byName = new Map<string, EnvVarUse>();
  for (const a of analyses) {
    if (!isAuthored(a.filePath)) continue;
    for (const ds of a.dataSources) {
      if (ds.kind !== "env") continue;
      const name = envVarName(ds);
      if (!name) continue;
      const use = byName.get(name) ?? byName.set(name, { name, readBy: [], setBy: [] }).get(name)!;
      if (use.readBy.length < 50) use.readBy.push({ file: a.filePath, line: ds.line, ...(a.projectId ? { project: a.projectId } : {}) });
    }
  }
  if (byName.size === 0) return [];
  for (const svc of deployment?.services ?? []) {
    for (const key of svc.envKeys ?? []) {
      const use = byName.get(key);
      if (!use) continue;
      if (svc.project && !use.readBy.some((r) => r.project === svc.project)) continue;
      use.setBy.push({ service: svc.name, file: svc.dockerfile && !svc.composeFiles?.length ? svc.dockerfile : svc.composeFile });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
