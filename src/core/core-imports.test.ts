import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

/**
 * Core names no language: it reaches a plugin only through the registry and the hooks a plugin's meta states. An
 * import of `extractors/plugins/<language>/` from production code under `src/core/` is a language rule written into
 * core; it belongs behind a hook. (`extractors/plugins/shared/` holds language-free helpers and is not a plugin.)
 */
const CORE = join(__dirname);
const PLUGIN_IMPORT = /\bfrom\s+["'][^"']*\/extractors\/plugins\/(?!shared\/)([^/"']+)\//g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("core imports no language plugin", () => {
  it("has no import of extractors/plugins/<language>/ in production code", () => {
    const found: string[] = [];
    for (const file of sources(CORE)) {
      // latin1: some core sources hold a NUL byte, which is no reason to skip them.
      const text = readFileSync(file, "latin1");
      for (const m of text.matchAll(PLUGIN_IMPORT)) found.push(`${relative(CORE, file)} → plugins/${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it("would catch one", () => {
    PLUGIN_IMPORT.lastIndex = 0;
    expect([...'import { x } from "../extractors/plugins/python/module-resolver.js";'.matchAll(PLUGIN_IMPORT)].map((m) => m[1])).toEqual(["python"]);
    expect([...'import { y } from "../extractors/plugins/shared/path-utils.js";'.matchAll(PLUGIN_IMPORT)]).toEqual([]);
  });
});
