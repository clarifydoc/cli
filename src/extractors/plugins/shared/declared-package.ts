import type { PackageEcosystem, PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage } from "../../../types/language-plugin.js";

/**
 * Helpers for the plugins' manifest parsers (`<lang>/package-manifests.ts`).
 * Leaf module: manifests import it, so it may import nothing but types.
 */

/** One declared dependency (field order is the order `project-summary.json` writes). */
export function declared(
  name: string,
  version: string | null,
  ecosystem: PackageEcosystem,
  scope: PackageScope,
  declaredIn: string,
): DeclaredPackage {
  return { name, version, ecosystem, scope, declaredIn };
}

/** A manifest's top-level JSON object, or null when the text does not parse. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The value of `key` inside one of `sections` of a TOML text — the package's
 * own name in Cargo's `[package]` or pyproject's `[project]`. Bounded by the
 * section: a `name` in a later table (a dependency's) is not read.
 */
export function tomlSectionValue(text: string, sections: readonly string[], key: string): string | null {
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { inside = sections.includes(section[1]!.trim()); continue; }
    if (!inside) continue;
    const kv = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`).exec(line);
    if (kv) return kv[1]!;
  }
  return null;
}
