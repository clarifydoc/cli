import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { hclString, parseHcl, registryAddress } from "../../shared/hcl.js";
import { declared } from "../shared/declared-package.js";

/**
 * Registry modules a `.tf` file calls: `module "x" { source = "namespace/name/provider", version = "~> 4.0" }`.
 * A local path, a git or archive URL and any other source address are no registry package; a hosted-registry
 * address (`registry.terraform.io/…`) is the same module as its short form (`registryAddress`).
 */
function parseTerraform(text: string, declaredIn: string): DeclaredPackage[] {
  if (!/\bmodule\s+"/.test(text)) return [];
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const block of parseHcl(text)) {
    if (block.type !== "module") continue;
    const source = hclString(block.attrs.get("source"));
    const name = source ? registryAddress(source) : undefined;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(declared(name, hclString(block.attrs.get("version")), "terraform", "prod", declaredIn));
  }
  return out;
}

export const terraformPackageManager: PackageManagerSpec = {
  ecosystem: "terraform",
  manifests: [{ files: ["**/*.tf"], glob: { deep: 6, limit: 200 }, parse: (text, file) => parseTerraform(text, file.declaredIn) }],
};
