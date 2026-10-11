import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * The published tool version, single-sourced from `package.json`.
 *
 * It was written by hand in two places — the manifest and the CLI's
 * `.version()` call — which is one copy too many for a number that identifies
 * which build produced an artifact.
 *
 * The manifest is found by walking up from this module rather than by a fixed
 * relative path, because the same code runs from `src/core/` under vitest and
 * from the bundled `dist/` at runtime, and those sit at different depths.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: string; version?: string };
        // Skip a nested package.json that is not ours (a bundled dependency).
        if (parsed.version && (parsed.name === "clarifydoc" || i > 0)) return parsed.version;
      } catch {
        // Unreadable or malformed: keep walking, then fall through to the default.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/** The running tool's version from its `package.json`; `"0.0.0"` when none was found. */
export const TOOL_VERSION: string = readVersion();
