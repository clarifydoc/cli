import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, tomlSectionValue } from "../shared/declared-package.js";

/** Cargo: `Cargo.toml` dependency tables (flat lists and `[dependencies.foo]` tables). */
function parseCargo(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const lines = text.split(/\r?\n/);
  let scope: PackageScope | null = null;
  // A `[dependencies.foo]` table declares the package across several lines;
  // hold it open until the next section (or EOF) so its `version = "…"` is read.
  let pending: { name: string; scope: PackageScope; version: string | null } | null = null;
  const flush = () => { if (pending) { out.push(declared(pending.name, pending.version, "cargo", pending.scope, declaredIn)); pending = null; } };

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      flush();
      const s = section[1]!.trim();
      const table = s.match(/^(dev-|build-)?dependencies\.(.+)$/);
      if (table) {
        scope = null; // inside a table block, not a flat list
        pending = { name: table[2]!, scope: table[1] ? "dev" : "prod", version: null };
      } else if (s === "dependencies" || s.endsWith(".dependencies")) scope = "prod";
      else if (s === "dev-dependencies" || s.endsWith(".dev-dependencies")) scope = "dev";
      else if (s === "build-dependencies" || s.endsWith(".build-dependencies")) scope = "dev";
      else scope = null;
      continue;
    }
    if (pending) {
      const v = line.match(/^version\s*=\s*"([^"]+)"/);
      if (v) pending.version = v[1]!;
      continue;
    }
    if (!scope) continue;
    // name = "1.2" | name = { version = "1.2", ... }
    const dep = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!dep) continue;
    const rhs = dep[2]!;
    const version = rhs.match(/^"([^"]+)"/)?.[1] ?? rhs.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? null;
    out.push(declared(dep[1]!, version, "cargo", scope, declaredIn));
  }
  flush();
  return out;
}

export const cargoPackageManager: PackageManagerSpec = {
  ecosystem: "cargo",
  manifests: [{
    files: ["Cargo.toml"],
    parse: (text, file) => parseCargo(text, file.declaredIn),
    // `[package] name = "x"` — not a workspace-only manifest's `[workspace.package]`.
    selfName: (text) => tomlSectionValue(text, ["package"], "name"),
  }],
  // `serde_json::Value` → `serde-json`: a crate is imported with `_` for its `-`.
  importKey(s) {
    const head = s.split("::")[0]!.toLowerCase();
    if (["crate", "self", "super", "std", "core", "alloc"].includes(head)) return null;
    return head.replace(/_/g, "-");
  },
  packageKey: (name) => name.toLowerCase().replace(/_/g, "-"),
  assertsUnused: true,
};
