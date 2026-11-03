import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * RSpec when the project declares it, else Rails' minitest runner, on the spec/test files — an
 * RSpec file narrowed to the lines of its examples that reach the change (`spec/club_spec.rb:5:12`)
 * when every test reaching it there is a marked example or group.
 */
export function rubyTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const rspec = ctx.packages.has("rspec") || ctx.packages.has("rspec-rails") || files.every((f) => /_spec\.rb$/.test(f));
  if (!rspec) return `bin/rails test ${files.join(" ")}`;
  return `bundle exec rspec ${files.map((f) => withLines(f, tests.filter((t) => t.file === f))).join(" ")}`;
}

/**
 * `spec/club_spec.rb:5:12`: the file, run only at the lines of its examples and groups — whole when
 * none is marked, or a hook or the file's own statements reach the change. A helper method reaching
 * it is reached in turn by the examples that call it, which are listed too.
 */
function withLines(file: string, targets: readonly TestTarget[]): string {
  const lines: number[] = [];
  for (const t of targets) {
    const cases = t.cases ?? [];
    if (!t.names?.length || t.names.includes("<setup>") || cases.some((c) => c.hook)) return file;
    lines.push(...cases.map((c) => c.line));
  }
  return lines.length ? `${file}:${[...new Set(lines)].sort((a, b) => a - b).join(":")}` : file;
}
