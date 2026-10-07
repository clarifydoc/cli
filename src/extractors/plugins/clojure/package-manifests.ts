import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Clojars / Maven coordinates from `deps.edn` and Leiningen `project.clj`. */
function parseClojureDeps(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string | null) => {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(declared(name, version, "clojars", "prod", declaredIn)); }
  };
  // deps.edn: `org.clojure/clojure {:mvn/version "1.11.1"}`
  for (const m of text.matchAll(/([\w.\-]+\/[\w.\-]+)\s*\{[^}]*:mvn\/version\s+"([^"]+)"/g)) add(m[1]!, m[2]!);
  for (const m of text.matchAll(/([\w.\-]+\/[\w.\-]+)\s*\{[^}]*:(?:git|local)\/(?:url|root)/g)) add(m[1]!, null);
  // Leiningen project.clj: `:dependencies [[ring "1.9.0"] [compojure "1.7.0"]]`
  for (const m of text.matchAll(/\[\s*([\w.\-]+(?:\/[\w.\-]+)?)\s+"([^"]+)"\s*\]/g)) add(m[1]!, m[2]!);
  return out;
}

// A Clojure namespace maps too loosely onto a Clojars group/artifact to
// assert usage: declared-only (no importKey — usage stays unknown).
export const clojarsPackageManager: PackageManagerSpec = {
  ecosystem: "clojars",
  manifests: [
    { files: ["deps.edn"], parse: (text, file) => parseClojureDeps(text, file.declaredIn) },
    { files: ["project.clj"], parse: (text, file) => parseClojureDeps(text, file.declaredIn) },
  ],
};
