import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** PHPUnit (or Pest) filtered to the test methods, else to the test classes. */
export function phpTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const names = new Set<string>();
  for (const t of tests) {
    const methods = t.names.map((n) => n.split(/::|\./).pop()!).filter((n) => /^test/i.test(n));
    if (methods.length) methods.forEach((m) => names.add(m));
    else names.add(t.file.slice(t.file.lastIndexOf("/") + 1).replace(/\.php$/, ""));
  }
  if (!names.size) return null;
  const bin = ctx.packages.has("pestphp/pest") ? "vendor/bin/pest" : "vendor/bin/phpunit";
  return `${bin} --filter '${[...names].sort().join("|")}'`;
}
