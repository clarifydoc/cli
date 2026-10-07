import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import type { PackageScope } from "../../../types/analysis.js";
import { declared } from "../shared/declared-package.js";

/**
 * `mojoproject.toml` / `pixi.toml`: conda packages under `[dependencies]`
 * (`max = ">=24.5,<25"`) and `[feature.test.dependencies]` (dev).
 */
function parsePixi(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let scope: PackageScope | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      scope = /^dependencies$/.test(section[1]!) ? "prod" : /^feature\.[\w-]+\.dependencies$/.test(section[1]!) ? "dev" : null;
      continue;
    }
    const dep = scope ? /^([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(line) : null;
    if (dep && dep[1] !== "python") out.push(declared(dep[1]!, (dep[2] ?? dep[3] ?? "").trim() || null, "conda", scope!, declaredIn));
  }
  return out;
}

export const condaPackageManager: PackageManagerSpec = {
  ecosystem: "conda",
  manifests: [{ files: ["mojoproject.toml", "pixi.toml"], parse: (text, file) => parsePixi(text, file.declaredIn) }],
  importKey: (s) => (s.startsWith(".") ? null : s.split(".")[0]!.toLowerCase()),
};
