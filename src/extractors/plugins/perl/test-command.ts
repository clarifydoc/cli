import type { TestTarget } from "../../../types/language-plugin.js";

/** `prove -l t/club.t t/player.t`: the harness runs each `.t` file, `-l` putting `lib/` on the include path; a test not in a `.t` file runs the whole `t/` tree. */
export function perlTestCommand(tests: readonly TestTarget[]): string | null {
  if (!tests.length) return null;
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (files.some((f) => !f.endsWith(".t"))) return "prove -lr t";
  return `prove -l ${files.join(" ")}`;
}
