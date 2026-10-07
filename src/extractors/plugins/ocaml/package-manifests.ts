import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import type { PackageScope } from "../../../types/analysis.js";
import { declared } from "../shared/declared-package.js";

/** Build- and test-only filters: `{with-test}`, `{build}`, `:with-test`, `:with-doc`. */
const DEV_FILTER = /with-test|with-doc|with-dev-setup|\bbuild\b/;

/** `*.opam`: `depends: [ "dream" {>= "1.0.0~alpha5"} "alcotest" {with-test} ]`. */
function parseOpam(text: string, declaredIn: string): DeclaredPackage[] {
  const block = /^depends\s*:\s*\[([\s\S]*?)^\]/m.exec(text)?.[1] ?? /^depends\s*:\s*\[([^\]]*)\]/m.exec(text)?.[1];
  if (!block) return [];
  const out: DeclaredPackage[] = [];
  for (const m of block.matchAll(/"([^"]+)"\s*(\{[^}]*\})?/g)) {
    const filter = m[2] ?? "";
    const version = /"([^"]+)"/.exec(filter)?.[1] ?? null;
    if (m[1] !== "ocaml") out.push(declared(m[1]!, version, "opam", DEV_FILTER.test(filter) ? "dev" : "prod", declaredIn));
  }
  return out;
}

/** `dune-project`: each `(package … (depends dream (caqti (>= 2.0)) (alcotest :with-test)))`. */
function parseDuneProject(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const start of text.matchAll(/\(depends\b/g)) {
    let depth = 0;
    let end = start.index!;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    const body = text.slice(start.index! + "(depends".length, end);
    // Top-level entries: a bare name, or `(name constraint…)`.
    let d = 0;
    let token = "";
    const flush = (entry: string) => {
      const m = /^\(?\s*([a-z][\w.-]*)([\s\S]*)$/.exec(entry.trim());
      if (!m || m[1] === "ocaml") return;
      // `(dream (>= 1.0.0~alpha5))` — dune writes the bound unquoted, opam quoted.
      const version = /\(\s*(?:>=|=|>|<=|<)\s*"?([^\s)"]+)"?/.exec(m[2]!)?.[1] ?? null;
      const scope: PackageScope = DEV_FILTER.test(m[2]!) ? "dev" : "prod";
      out.push(declared(m[1]!, version, "opam", scope, declaredIn));
    };
    for (const ch of body) {
      if (ch === "(") { if (d === 0 && token.trim()) { for (const t of token.trim().split(/\s+/)) flush(t); token = ""; } d++; token += ch; continue; }
      if (ch === ")") { d--; token += ch; if (d === 0) { flush(token); token = ""; } continue; }
      token += ch;
    }
    for (const t of token.trim().split(/\s+/).filter(Boolean)) flush(t);
  }
  return out;
}

export const opamPackageManager: PackageManagerSpec = {
  ecosystem: "opam",
  manifests: [
    { files: ["*.opam", "**/*.opam"], glob: { deep: 2, limit: 20 }, parse: (text, file) => parseOpam(text, file.declaredIn) },
    { files: ["dune-project"], parse: (text, file) => parseDuneProject(text, file.declaredIn) },
  ],
  // A module names its library: `Caqti_lwt` is the `caqti-lwt` package, `Lwt_unix` a library of `lwt`.
  importKey: (s) => (/^[A-Z]/.test(s) ? s.toLowerCase().replace(/_/g, "-") : null),
  prefixMatch: { separator: "-", bidirectional: true },
};
