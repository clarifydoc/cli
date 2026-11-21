import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/**
 * Registry modules a `.tf` file calls: `module "x" { source = "namespace/name/provider", version = "~> 4.0" }`.
 * A local path, a git or archive URL and any other source address are no registry package; a hosted-registry
 * address (`registry.terraform.io/…`) is the same module as its short form.
 */
function parseTerraform(text: string, declaredIn: string): DeclaredPackage[] {
  if (!/\bmodule\s+"/.test(text)) return [];
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  const heads = [...text.matchAll(/^\s*module\s+"[^"]+"\s*\{/gm)];
  for (const [i, m] of heads.entries()) {
    // The block's text runs to the next `module` block: its own `source` and `version` come first.
    const body = text.slice(m.index! + m[0].length, heads[i + 1]?.index ?? text.length);
    const source = /(?:^|\s)source\s*=\s*"([^"$]+)"/.exec(body)?.[1];
    if (!source || /^(?:\.|\/|[a-z0-9+.-]+::|[a-z]+:\/\/)/i.test(source) || /^(?:github\.com|bitbucket\.org)\//i.test(source)) continue;
    const parts = source.replace(/\?.*$/, "").replace(/\/\/.*$/, "").split("/");
    if (parts.length === 4 && /^registry\.terraform\.io$/i.test(parts[0]!)) parts.shift();
    if (parts.length !== 3 || !parts.every((p) => /^[\w.-]+$/.test(p))) continue;
    const name = parts.join("/");
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const version = /(?:^|\s)version\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null;
    out.push(declared(name, version, "terraform", "prod", declaredIn));
  }
  return out;
}

export const terraformPackageManager: PackageManagerSpec = {
  ecosystem: "terraform",
  manifests: [{ files: ["**/*.tf"], glob: { deep: 6, limit: 200 }, parse: (text, file) => parseTerraform(text, file.declaredIn) }],
};
