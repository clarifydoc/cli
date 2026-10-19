import type { TestTarget } from "../../../types/language-plugin.js";

/** `cargo test -- <names>`: libtest takes several name filters after `--`. */
export function rustTestCommand(tests: readonly TestTarget[]): string | null {
  const names = [...new Set(tests.flatMap((t) => t.names).map((n) => n.split(/::|\./).pop()!).filter((n) => n && !n.startsWith("<")))].sort();
  if (!tests.length) return null;
  return names.length ? `cargo test -- ${names.join(" ")}` : "cargo test";
}
