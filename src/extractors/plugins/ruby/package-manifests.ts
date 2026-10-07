import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Bundler: `Gemfile` `gem` lines, scoped by their (block or inline) group. */
function parseGemfile(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const lines = text.split(/\r?\n/);
  const groupStack: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    const groupOpen = line.match(/^group\s+(.+?)\s+do$/);
    if (groupOpen) { groupStack.push(groupOpen[1]!); continue; }
    if (line === "end" && groupStack.length) { groupStack.pop(); continue; }
    const gem = line.match(/^gem\s+['"]([^'"]+)['"]/);
    if (!gem) continue;
    // Positional args after the name are version constraints ('~> 7.0', '>= 6', '< 8');
    // they end at the first keyword option (require:, github:, branch: …), whose
    // quoted *values* must not be mistaken for constraints.
    const constraints: string[] = [];
    let rest = line.slice(gem[0].length);
    let arg: RegExpMatchArray | null;
    while ((arg = rest.match(/^\s*,\s*['"]([^'"]+)['"](?=\s*(?:,|$))/))) {
      constraints.push(arg[1]!);
      rest = rest.slice(arg[0].length);
    }
    const inlineGroup = line.match(/group\s*(?:=>|:)\s*\[?\s*:?(\w+)/);
    const groups = [...groupStack, inlineGroup?.[1] ?? ""].join(" ").toLowerCase();
    const scope: PackageScope = /develop|test/.test(groups) ? "dev" : "prod";
    out.push(declared(gem[1]!, constraints.length ? constraints.join(", ") : null, "rubygems", scope, declaredIn));
  }
  return out;
}

/**
 * `Gemfile.lock` resolved versions. Every `specs:` block (under GEM, GIT and
 * PATH sections alike) lists resolved gems as 4-space-indented `name (x.y.z)`
 * lines; the 6-space lines beneath each are that gem's own dependency
 * constraints, not resolutions, and are skipped. Platform-suffixed versions
 * (`1.15.4-x86_64-linux`) keep only the version half — gem versions themselves
 * never contain `-`. Used to backfill Gemfile entries declared without an
 * inline constraint; the lock never introduces packages (transitive gems are
 * not declared dependencies).
 */
function parseGemfileLock(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inSpecs = false; continue; } // section header (GEM/GIT/PLATFORMS/…)
    if (/^ {2}\S/.test(line)) { inSpecs = /^ {2}specs:\s*$/.test(line); continue; }
    if (!inSpecs) continue;
    const spec = line.match(/^ {4}(\S+) \(([^)]+)\)\s*$/);
    if (!spec) continue;
    const version = spec[2]!.split("-")[0]!;
    if (!versions.has(spec[1]!)) versions.set(spec[1]!, version);
  }
  return versions;
}

export const rubygemsPackageManager: PackageManagerSpec = {
  ecosystem: "rubygems",
  manifests: [
    {
      files: ["Gemfile"],
      // Gemfiles routinely declare gems without a constraint (versions live in
      // the lock) — backfill those from Gemfile.lock; an explicit constraint in
      // the Gemfile stays authoritative as the *declared* version.
      async parse(text, file) {
        const gems = parseGemfile(text, file.declaredIn);
        const lock = await file.readSibling("Gemfile.lock");
        if (lock) {
          const locked = parseGemfileLock(lock);
          for (const g of gems) g.version ??= locked.get(g.name) ?? null;
        }
        return gems;
      },
    },
  ],
  importKey: (s) => (s.startsWith(".") ? null : s.split("/")[0]!.toLowerCase()),
};
