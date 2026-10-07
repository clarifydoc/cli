import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** rebar3: `{deps, [ {cowboy, "2.10.0"}, {jsx, "3.1.0"}, {gun, {git, "…"}} ]}.` */
function parseRebar(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const block = text.match(/\{\s*deps\s*,\s*\[([\s\S]*?)\]\s*\}/);
  if (!block) return out;
  for (const m of block[1]!.matchAll(/\{\s*([a-z][\w]*)\s*,\s*(?:"([^"]+)")?/g)) {
    out.push(declared(m[1]!, m[2] ?? null, "hex", "prod", declaredIn));
  }
  return out;
}

/** rebar3 resolves from Hex: its packages join Elixir's `hex` ecosystem, matched there. */
export const rebarPackageManager: PackageManagerSpec = {
  ecosystem: "hex",
  manifests: [{ files: ["rebar.config"], parse: (text, file) => parseRebar(text, file.declaredIn) }],
};
