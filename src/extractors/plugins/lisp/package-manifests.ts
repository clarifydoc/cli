import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import type { PackageScope } from "../../../types/analysis.js";
import { declared } from "../shared/declared-package.js";
import { isKeyword, tryReadForms, type Form } from "../shared/sexpr.js";

function items(f: Form | undefined): Form[] {
  return f && (f.kind === "list" || f.kind === "vector") ? f.items : [];
}
function name(f: Form | undefined): string | null {
  if (!f) return null;
  if (f.kind === "string") return f.value;
  if (f.kind === "keyword" || f.kind === "symbol") return f.name.replace(/^#?:/, "");
  return null;
}

/** Racket `info.rkt`: `(define deps '("base" ("db-lib" #:version "1.5")))`, `build-deps` (dev). */
function parseInfoRkt(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const f of tryReadForms(text, "lisp") ?? []) {
    const [h, target, value] = items(f);
    if (name(h) !== "define") continue;
    const scope: PackageScope | null = name(target) === "deps" ? "prod" : name(target) === "build-deps" ? "dev" : null;
    if (!scope) continue;
    for (const dep of items(value)) {
      const parts = items(dep);
      // A source URL names the package by its repository: `https://…/userdb.git#main` → `userdb`.
      const pkg = name(parts.length ? parts[0] : dep)?.replace(/^(?:git\+)?[a-z]+:\/\/.*\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/, "$1");
      const vi = parts.findIndex((x) => isKeyword(x, "version"));
      if (pkg && pkg !== "base") out.push(declared(pkg, vi >= 0 ? name(parts[vi + 1]) : null, "racket", scope, declaredIn));
    }
  }
  return out;
}

/** ASDF `*.asd`: each `(defsystem "shop" :depends-on ("dexador" :postmodern (:version "x" "1.0")))`. */
function parseAsd(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const f of tryReadForms(text, "lisp") ?? []) {
    const parts = items(f);
    if (!/(?:^|:)defsystem$/.test(name(parts[0]) ?? "")) continue;
    const system = name(parts[1]) ?? "";
    // A test system (`shop/tests`) declares dev dependencies.
    const scope: PackageScope = /[/-]tests?$/.test(system) ? "dev" : "prod";
    const di = parts.findIndex((x) => isKeyword(x, "depends-on"));
    for (const dep of di >= 0 ? items(parts[di + 1]) : []) {
      const d = items(dep);
      const pkg = d.length ? (isKeyword(d[0], "version") ? name(d[1]) : null) : name(dep);
      const version = d.length && isKeyword(d[0], "version") ? name(d[2]) : null;
      // A dependency on the system's own sub-system (`shop/db`) is no package.
      if (!pkg || pkg.startsWith(`${system}/`) || seen.has(pkg)) continue;
      seen.add(pkg);
      out.push(declared(pkg.toLowerCase(), version, "quicklisp", scope, declaredIn));
    }
  }
  return out;
}

export const racketPackageManager: PackageManagerSpec = {
  ecosystem: "racket",
  manifests: [{ files: ["info.rkt"], parse: (text, file) => parseInfoRkt(text, file.declaredIn) }],
  // `(require web-server/servlet)` loads a collection of the `web-server-lib` package.
  importKey: (s) => (s.startsWith(".") ? null : s.split("/")[0]!.toLowerCase()),
  prefixMatch: { separator: "-", bidirectional: true },
};

export const quicklispPackageManager: PackageManagerSpec = {
  ecosystem: "quicklisp",
  manifests: [{ files: ["*.asd", "**/*.asd"], glob: { deep: 2, limit: 20 }, parse: (text, file) => parseAsd(text, file.declaredIn) }],
  importKey: (s) => (s.startsWith(".") ? null : s.toLowerCase()),
};
