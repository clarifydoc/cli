import type { ImportResolveContext } from "../../../types/language-plugin.js";

/**
 * The project file a Ruby `require "league/club"` (or an `autoload :Club,
 * "league/club"`) loads: Ruby looks the path up on its load path and loads
 * `league/club.rb` — never a directory, so `require "league"` beside both
 * `lib/league.rb` and `lib/league/` is the file. Tried beside the requiring
 * file, then under each enclosing directory and its `lib/` (the load path a
 * gem or Rails app sets up), nearest first, then as the one file whose path
 * ends that way. Null when no project file answers (a gem, the standard
 * library). A relative path (`require_relative "../x"`) is core's to resolve.
 * Leaf code.
 */
export function resolveRubyRequire(importingFile: string, source: string, _specifier: string | undefined, ctx: ImportResolveContext): string | null {
  if (source.startsWith(".") || source.startsWith("/") || !/^[\w./-]+$/.test(source)) return null;
  const path = `${source.replace(/\.rb$/, "")}.rb`;
  const join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);
  for (let dir = importingFile.includes("/") ? importingFile.slice(0, importingFile.lastIndexOf("/")) : ""; ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")))) {
    for (const candidate of [join(dir, path), join(dir, `lib/${path}`)]) {
      if (candidate !== importingFile && ctx.files.has(candidate)) return candidate;
    }
    if (!dir) break;
  }
  let only: string | null = null;
  for (const file of ctx.files) {
    if (!file.endsWith(`/${path}`) || file === importingFile) continue;
    if (only) return null;
    only = file;
  }
  return only;
}
