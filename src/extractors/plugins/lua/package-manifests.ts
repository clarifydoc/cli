import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** LuaRocks: the `dependencies = { "name >= 1.0", … }` block of a `.rockspec`. */
function parseRockspec(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const block = text.match(/dependencies\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return out;
  for (const q of block[1]!.matchAll(/["']([^"']+)["']/g)) {
    const parts = q[1]!.trim().split(/\s+/); // "name >= 1.0"
    const name = parts[0];
    if (!name || name.toLowerCase() === "lua") continue; // skip the runtime itself
    out.push(declared(name, parts.slice(1).join(" ") || null, "luarocks", "prod", declaredIn));
  }
  return out;
}

export const luarocksPackageManager: PackageManagerSpec = {
  ecosystem: "luarocks",
  manifests: [
    { files: ["*.rockspec", "**/*.rockspec"], glob: { deep: 2, limit: 10 }, parse: (text, file) => parseRockspec(text, file.declaredIn) },
  ],
  // `require "lapis.application"` → `lapis`.
  importKey: (s) => s.split(/[./]/)[0]!.toLowerCase(),
};
