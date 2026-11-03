import type { TestTarget } from "../../../types/language-plugin.js";

/**
 * `cargo test -- <names>`: libtest takes several name filters after `--`, each matched anywhere in
 * a test's path. A marked test is named by its module path (`tests::finds_leader`), so a case of
 * an inline `#[cfg(test)]` module is told from a namesake elsewhere; another by its leaf name.
 */
export function rustTestCommand(tests: readonly TestTarget[]): string | null {
  if (!tests.length) return null;
  const filters = tests.flatMap((t) =>
    t.cases?.length
      ? t.cases.filter((c) => !c.hook).map((c) => c.path.join("::"))
      : t.names.map((n) => n.split(/::|\./).pop()!).filter((n) => n && !n.startsWith("<")),
  );
  const names = [...new Set(filters.filter(Boolean))].sort();
  return names.length ? `cargo test -- ${names.join(" ")}` : "cargo test";
}
