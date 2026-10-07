import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/**
 * PowerShell Gallery: a module manifest's (`.psd1`) `RequiredModules` —
 * `@('Pester', @{ ModuleName = 'Az.Accounts'; ModuleVersion = '2.0.0' })`.
 */
function parseModuleManifest(text: string, declaredIn: string): DeclaredPackage[] {
  const start = /\bRequiredModules\s*=\s*@\(/i.exec(text);
  if (!start) return [];
  let depth = 1;
  let i = start.index + start[0].length;
  const begin = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
  }
  const block = text.slice(begin, i - 1);
  const out: DeclaredPackage[] = [];
  // Hashtable entries first (they carry versions), then bare names outside them.
  for (const m of block.matchAll(/@\{([^}]*)\}/g)) {
    const name = /ModuleName\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    const version = /(?:Required|Module)Version\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1] ?? null;
    if (name) out.push(declared(name, version, "psgallery", "prod", declaredIn));
  }
  for (const m of block.replace(/@\{[^}]*\}/g, "").matchAll(/["']([A-Za-z][\w.]*)["']/g)) {
    out.push(declared(m[1]!, null, "psgallery", "prod", declaredIn));
  }
  return out;
}

export const psgalleryPackageManager: PackageManagerSpec = {
  ecosystem: "psgallery",
  manifests: [{ files: ["*.psd1", "**/*.psd1"], glob: { deep: 3, limit: 20 }, parse: (text, file) => parseModuleManifest(text, file.declaredIn) }],
  // `Import-Module Az.Accounts` / `using module Pester`: the module name; a
  // path names a project file, not a package.
  importKey: (s) => (/^[A-Za-z][\w.]*$/.test(s) ? s.toLowerCase() : null),
};
