import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import type { PackageScope } from "../../../types/analysis.js";
import { declared } from "../shared/declared-package.js";

/**
 * `shard.yml`: the keys under `dependencies:` (prod) and
 * `development_dependencies:` (dev), each a map whose `version:` (or
 * `branch:` / `commit:`) pins it:
 *
 *     dependencies:
 *       kemal:
 *         github: kemalcr/kemal
 *         version: ~> 1.4
 */
function parseShardYml(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let scope: PackageScope | null = null;
  let current: { name: string; version: string | null } | null = null;
  const flush = () => {
    if (current && scope) out.push(declared(current.name, current.version, "shards", scope, declaredIn));
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const section = /^(\w+):/.exec(line);
    if (section) {
      flush();
      scope = section[1] === "dependencies" ? "prod" : section[1] === "development_dependencies" ? "dev" : null;
      continue;
    }
    if (!scope) continue;
    const dep = /^ {1,4}([\w.-]+):\s*$/.exec(line);
    if (dep) {
      flush();
      current = { name: dep[1]!, version: null };
      continue;
    }
    const pin = /^\s+(?:version|branch|commit|tag):\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
    if (pin && current && current.version === null) current.version = pin[1]!;
  }
  flush();
  return out;
}

export const shardsPackageManager: PackageManagerSpec = {
  ecosystem: "shards",
  manifests: [{ files: ["shard.yml"], parse: (text, file) => parseShardYml(text, file.declaredIn) }],
  // `require "granite/adapter/pg"` loads the `granite` shard; `./x` is a file.
  importKey: (s) => (/^[\w-]/.test(s) ? s.split("/")[0]!.toLowerCase() : null),
};
