/**
 * `clarifydoc_extract package=…`: an installed third-party package's exported
 * API, as the package manager that installed it can read it
 * (`PackageManagerSpec.installedApi`) — so an agent writes against the version
 * the project has, not the one it remembers. Read on demand, capped.
 */

import { dirname, join, relative } from "path";
import type { LoadedAnalysis } from "./store.js";
import type { InstalledPackageApi } from "../types/language-plugin.js";
import { PACKAGE_MANAGERS } from "../extractors/registry.js";
import { bulletList, fenced, joinLines, plural } from "./format.js";
import { noResults } from "./empty.js";

/** Where to look, nearest first: the directories of the manifests declaring it, each sub-project, the root. */
function installDirs(loaded: LoadedAnalysis, root: string, name: string): string[] {
  const pkg = (loaded.summary.externalPackages ?? []).filter((p) => p.name.toLowerCase() === name.toLowerCase());
  const declared = pkg.flatMap((p) => [p.declaredIn, ...(p.declarations ?? []).map((d) => d.declaredIn)]).filter((x): x is string => !!x);
  return [...new Set([
    ...declared.map((d) => join(root, dirname(d))),
    ...(loaded.summary.subProjects ?? []).map((p) => join(root, p.root || ".")),
    root,
  ])];
}

export async function packageApiText(loaded: LoadedAnalysis, root: string, name: string, symbol: string | undefined, limit = 80): Promise<string> {
  const known = (loaded.summary.externalPackages ?? []).find((p) => p.name.toLowerCase() === name.toLowerCase());
  const managers = PACKAGE_MANAGERS.filter((m) => m.installedApi).sort((a, b) => Number(b.ecosystem === known?.ecosystem) - Number(a.ecosystem === known?.ecosystem));
  const dirs = installDirs(loaded, root, name);
  let api: InstalledPackageApi | null = null;
  for (const m of managers) {
    api = await m.installedApi!(dirs, name, symbol);
    if (api) break;
  }
  if (!api) {
    return noResults({
      headline: `${name} is not installed where its project would read it${managers.length ? ` (looked in ${plural(dirs.length, "directory", "directories")} for ${managers.map((m) => m.ecosystem).join(", ")} packages)` : ""}.`,
      holds: known ? `The analysis has it declared in ${known.declaredIn}${known.version ? ` at ${known.version}` : ""}${known.resolvedVersion ? ` (locked ${known.resolvedVersion})` : ""}; install the dependencies to read its API.` : `The analysis knows ${plural((loaded.summary.externalPackages ?? []).length, "declared package")}.`,
      next: ["clarifydoc_health category=dependencies — what is declared, and where"],
    });
  }
  const rel = (f: string) => relative(root, f).split("\\").join("/");
  const head = `# ${api.name}${api.version ? ` ${api.version}` : ""} — ${plural(api.exports.length, "export")}${api.truncated ? " (capped)" : ""}, from ${rel(api.source)}`;
  const lines: string[] = [head];
  if (known?.version && api.version && !known.version.replace(/^[~^=v]/, "").startsWith(api.version.split(".")[0]!)) {
    lines.push(`Declared ${known.version} in ${known.declaredIn}; installed ${api.version} — the installed one is what runs.`);
  }
  if (symbol) {
    if (api.declaration) lines.push("", `## ${symbol} (${rel(api.declaration.file)}:${api.declaration.line})`, fenced(api.declaration.text, "ts"));
    else lines.push("", `${api.name} exports nothing named "${symbol}" in what was read.`);
  }
  if (!api.exports.length) lines.push("", "No exports could be read from what it ships.");
  else if (!symbol || !api.declaration) {
    lines.push("", ...bulletList(api.exports, limit, (e) => `${e.kind} ${e.name} — \`${e.signature}\` (${rel(e.file)}:${e.line})`));
  }
  return joinLines(lines);
}
