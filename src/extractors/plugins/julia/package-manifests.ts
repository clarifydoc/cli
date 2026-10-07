import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** `Project.toml` `[deps]` (prod) and `[extras]` (dev) — `Genie = "c43c736e-…"`. */
function parseProject(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let scope: "prod" | "dev" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { scope = section[1] === "deps" ? "prod" : section[1] === "extras" ? "dev" : null; continue; }
    const dep = scope ? /^([A-Za-z_][\w]*)\s*=\s*"/.exec(line) : null;
    if (dep) out.push(declared(dep[1]!, null, "julia", scope!, declaredIn));
  }
  return out;
}

export const juliaPackageManager: PackageManagerSpec = {
  ecosystem: "julia",
  manifests: [{ files: ["Project.toml", "JuliaProject.toml"], parse: (text, file) => parseProject(text, file.declaredIn) }],
  // `using Genie.Router` → `genie`.
  importKey: (s) => (/^[A-Za-z_]/.test(s) && !s.startsWith(".") ? s.split(".")[0]!.toLowerCase() : null),
};
