import type { TestTarget } from "../../../types/language-plugin.js";

/** `dotnet test --filter` on the test classes and methods (FullyQualifiedName contains them). */
export function dotnetTestCommand(tests: readonly TestTarget[]): string | null {
  const terms = new Set<string>();
  for (const t of tests) {
    const cls = t.file.slice(t.file.lastIndexOf("/") + 1).replace(/\.cs$/, "");
    const methods = t.names.filter((n) => n.includes(".") && !n.endsWith("<setup>"));
    if (!methods.length) terms.add(cls);
    for (const m of methods) terms.add(m.split(".").slice(-2).join("."));
  }
  if (!terms.size) return null;
  return `dotnet test --filter "${[...terms].sort().map((x) => `FullyQualifiedName~${x}`).join("|")}"`;
}
