import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** RSpec when the project declares it, else Rails' minitest runner, on the spec/test files. */
export function rubyTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const rspec = ctx.packages.has("rspec") || ctx.packages.has("rspec-rails") || files.every((f) => /_spec\.rb$/.test(f));
  return rspec ? `bundle exec rspec ${files.join(" ")}` : `bin/rails test ${files.join(" ")}`;
}
