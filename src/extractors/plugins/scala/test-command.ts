import type { TestTarget } from "../../../types/language-plugin.js";

/**
 * `sbt "testOnly *ClubSpec *PlayerSpec"`: sbt takes class-name globs, so each test file runs as the suite class it
 * declares — the class a test name leads with (`ClubSpec.creates`), else the file's own name, the convention every
 * Scala test framework follows. A file whose name is no identifier (`package.scala`) runs the whole `sbt test`.
 */
export function scalaTestCommand(tests: readonly TestTarget[]): string | null {
  if (!tests.length) return null;
  const classes = new Set<string>();
  for (const t of tests) {
    const lead = t.names.map((n) => /^([A-Z]\w*)\./.exec(n)?.[1]).find((n) => n !== undefined);
    const base = /(?:^|\/)([A-Za-z_]\w*)\.sc(?:ala)?$/.exec(t.file)?.[1];
    const cls = lead ?? base;
    if (!cls) return "sbt test";
    classes.add(cls);
  }
  return `sbt "testOnly ${[...classes].sort().map((c) => `*${c}`).join(" ")}"`;
}
