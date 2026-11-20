import type { CallBaseRef } from "../../../types/analysis.js";
import type { ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * Where a Rust service is told other services are: a base expression reading the environment —
 * `env::var("QUOTE_ADDR")`, `std::env::var_os(…)`, the build-time `env!("…")` / `option_env!("…")`.
 * The fallback literal (`.unwrap_or("http://quote:8090")`) is deliberately not stated: with no deployment fact for the
 * variable core would value the call by it and, a host no service is named for being "elsewhere", drop a link the
 * unresolved base kept.
 * The expression must open with the read (`my_env::var(…)`, a method named `var` on a project value, a read nested as an argument is none).
 * Core values the variable from the caller's deployment env.
 */
const ENV_READ = /^[\s&(]*(?:std::)?env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/;
/** A step that rewrites the value read. */
const TRANSFORMED = /\.(?:map|and_then|map_or|map_or_else|filter)\s*\(|format!/;

export function rustBaseRefOf(expr: string): CallBaseRef | null {
  const m = ENV_READ.exec(expr);
  return m && !TRANSFORMED.test(expr.slice(m[0].length)) ? { kind: "env", key: m[1]! } : null;
}

export const rustServiceConfig: ServiceConfigSpec = {
  baseRefOf: rustBaseRefOf,
};
