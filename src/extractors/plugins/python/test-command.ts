import type { TestTarget } from "../../../types/language-plugin.js";

/** pytest node ids: `file::test`, `file::Class::test` — pytest runs unittest cases too. */
export function pythonTestCommand(tests: readonly TestTarget[]): string | null {
  const ids: string[] = [];
  for (const t of [...tests].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const names = t.names.filter((n) => /(^|\.)test/i.test(n));
    if (!names.length) ids.push(t.file);
    else for (const n of names) ids.push(`${t.file}::${n.split(".").join("::")}`);
  }
  return ids.length ? `pytest ${[...new Set(ids)].join(" ")}` : null;
}
