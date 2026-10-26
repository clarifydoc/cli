import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** pub: `pubspec.yaml` dependencies / dev_dependencies. */
function parsePubspec(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const lines = text.split(/\r?\n/);
  let scope: PackageScope | null = null;
  for (const raw of lines) {
    if (/^dependencies\s*:/.test(raw)) { scope = "prod"; continue; }
    if (/^dev_dependencies\s*:/.test(raw)) { scope = "dev"; continue; }
    if (/^\S/.test(raw)) { scope = null; continue; } // dedented out of a deps block
    if (!scope) continue;
    // A dependency is a 2-space-indented `name:` key. `  name: ^1.2.3` or `  name:` (nested sdk/git/path).
    const m = raw.match(/^ {2}([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const name = m[1]!;
    let version: string | null = m[2]!.trim() || null;
    if (version && /^(sdk|git|path|hosted)\s*:/.test(version)) version = null; // non-semver source
    out.push(declared(name, version, "pub", scope, declaredIn));
  }
  return out;
}

/**
 * The file a Dart import or export names: `package:league/models/club.dart` →
 * the `league` package's `lib/models/club.dart`, a package no pubspec of the
 * repository names being a download and `dart:` the SDK; any other URI is
 * relative to the importing file (`'club.dart'`, `'../models/club.dart'`).
 */
export function dartImportedFile(importingFile: string, source: string, packages: ReadonlyArray<{ name: string; root: string }>): string | null | undefined {
  if (source.startsWith("dart:")) return null;
  const m = /^package:([A-Za-z0-9_]+)\/(.+)$/.exec(source);
  if (m) {
    const pkg = packages.find((p) => p.name === m[1]);
    return pkg ? `${pkg.root ? `${pkg.root}/` : ""}lib/${m[2]}` : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("/")) return undefined;
  const parts = importingFile.split("/").slice(0, -1);
  for (const seg of source.split("/")) {
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

export const pubPackageManager: PackageManagerSpec = {
  ecosystem: "pub",
  manifests: [{
    files: ["pubspec.yaml"],
    parse: (text, file) => parsePubspec(text, file.declaredIn),
    // `name: league` — what `package:league/…` imports name.
    selfName: (text) => /^name\s*:\s*["']?([A-Za-z0-9_]+)/m.exec(text)?.[1] ?? null,
  }],
  // `package:dio/dio.dart` → `dio`; `dart:async` is the SDK.
  importKey: (s) => s.match(/^package:([A-Za-z0-9_]+)/)?.[1]!.toLowerCase() ?? null,
  assertsUnused: true,
};
