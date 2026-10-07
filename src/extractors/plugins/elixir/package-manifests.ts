import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Hex: the dependency tuples of `mix.exs`. */
function parseMix(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // Dep tuples: {:phoenix, "~> 1.7"}, {:credo, "~> 1.7", only: [:dev, :test]},
  // {:foo, github: "org/foo"}. Require a version string or a dep-option keyword
  // as the second element so code tuples like `{:ok, result}` are rejected.
  const re = /\{\s*:([a-z_]\w*)\s*,\s*([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    const rest = m[2]!;
    if (!/^\s*(?:"|[a-z_]+:)/.test(rest)) continue; // not a dependency tuple
    const version = rest.match(/^\s*"([^"]+)"/)?.[1] ?? null;
    const dev = /only:\s*(?:\[[^\]]*:(?:dev|test)|:(?:dev|test))/.test(rest);
    out.push(declared(name, version, "hex", dev ? "dev" : "prod", declaredIn));
  }
  return out;
}

/** Hex packages (Erlang's rebar3 contributes `rebar.config` to the same ecosystem). */
export const hexPackageManager: PackageManagerSpec = {
  ecosystem: "hex",
  manifests: [{ files: ["mix.exs"], parse: (text, file) => parseMix(text, file.declaredIn) }],
  // `import Phoenix.Controller` → `phoenix`, `Ecto.Query` → `ecto`: the first
  // module segment approximates the package.
  importKey: (s) => s.split(".")[0]!.toLowerCase(),
};
