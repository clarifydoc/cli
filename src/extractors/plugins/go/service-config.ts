import type { CallBaseRef } from "../../../types/analysis.js";
import type { ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * Where a Go service is told other services are: a base expression reading
 * the environment (`os.Getenv("ORDERS_ADDR")`, `os.LookupEnv(…)`), as a
 * module value hands it on (`http://${os.Getenv("ORDERS_ADDR")}` from a
 * struct field the program sets from the variable). Core values it from the
 * caller's deployment env.
 */
const ENV_READ = /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/;

export function goBaseRefOf(expr: string): CallBaseRef | null {
  const m = ENV_READ.exec(expr);
  return m ? { kind: "env", key: m[1]! } : null;
}

export const goServiceConfig: ServiceConfigSpec = {
  baseRefOf: goBaseRefOf,
};
