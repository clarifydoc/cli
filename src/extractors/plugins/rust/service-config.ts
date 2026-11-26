import type { CallBaseRef } from "../../../types/analysis.js";
import type { ServiceConfigSpec } from "../../../types/language-plugin.js";

/**
 * Where a Rust service is told other services are: a base expression reading the environment —
 * `env::var("QUOTE_ADDR")`, `std::env::var_os(…)`, the build-time `env!("…")` / `option_env!("…")`.
 * The fallback literal is stated too — `.unwrap_or("http://quote:8090")`, `.unwrap_or("…".to_string())`,
 * `.unwrap_or_else(|_| "…".to_string())`, `.unwrap_or_else(|_| String::from("…"))` (`.into()`, `.to_owned()`) — and core
 * treats it as the code's guess: a host no service names keeps the unresolved base, never an outside service.
 * The expression must open with the read (`my_env::var(…)`, a method named `var` on a project value, a read nested as an argument is none).
 * Core values the variable from the caller's deployment env.
 */
const ENV_READ = /^[\s&(]*(?:std::)?env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/;
/** A step that rewrites the value read. */
const TRANSFORMED = /\.(?:map|and_then|map_or|map_or_else|filter)\s*\(|format!/;

/** `.unwrap_or(LIT)` / `.unwrap_or_else(|_| LIT)`, LIT a string literal alone or with one conversion, closing the chain. */
const FALLBACK =
  /^\s*\.unwrap_or(?:_else\(\s*\|\s*_?\w*\s*\|\s*|\(\s*)(?:String::from\(\s*"([^"\\{}]*)"\s*\)|"([^"\\{}]*)"(?:\s*\.(?:to_string|to_owned|into)\(\s*\))?)\s*\)\s*[,)]?\s*$/;

/**
 * A client base expression that OPENS with `env::var("X")` / `std::env::var_os` is an `env` ref, without the
 * `.unwrap_or("http://…")` fallback (a host the deployment does not name would read as "elsewhere" and drop the link an
 * unresolved base kept). Build-time `env!`/`option_env!`, a value rewritten by `.map(…)`/`format!`, a namesake module, a
 * method called `var`, or a read nested as an argument state nothing. The data-source reader already renders the hole
 * (`${env::var(…)…}/fixtures`) and core splits it into `baseExpr`.
 */
export function rustBaseRefOf(expr: string): CallBaseRef | null {
  const m = ENV_READ.exec(expr);
  if (!m) return null;
  const rest = expr.slice(m[0].length);
  const key = m[1]!;
  const fb = FALLBACK.exec(rest);
  if (fb) return { kind: "env", key, fallback: (fb[1] ?? fb[2])! };
  return TRANSFORMED.test(rest) ? null : { kind: "env", key };
}

export const rustServiceConfig: ServiceConfigSpec = {
  baseRefOf: rustBaseRefOf,
};
