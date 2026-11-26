import type { PackageRoot } from "../../../types/language-plugin.js";

const join = (root: string, rest: string): string => (root && rest ? `${root}/${rest}` : root || rest);

/**
 * The directory a Go import names: the module whose path the import starts
 * with (the longest, so a nested module wins over its parent), then the rest
 * of the import as a directory under that module's root — or a copy under the
 * importing module's `vendor/`. An import no module of the repository declares
 * (the standard library, a download) is none of its packages. With no module
 * known (no go.mod in the analysis) it cannot say.
 *
 * A Go package is its directory (manifest `importsNameDirectories`): an import is the repository package's `go.mod`
 * module path (or a `replace` to a local directory) plus the directory; the standard library and downloads are no
 * directory. Else the directory whose path ends with the longest run of the import's segments (a tie is no edge),
 * narrowed to the files declaring a name the importer uses, tests excluded. Dead code reads these edges as
 * reachability, so a phantom fan-out hides real gaps. `directoryScope` resolves a bare call a file does not define
 * into the caller's package directory: the one non-test sibling file declaring it.
 */
export function goPackageDirectory(
  importingFile: string,
  source: string,
  packages: readonly PackageRoot[],
  hasDirectory: (dir: string) => boolean,
): string | null | undefined {
  if (packages.length === 0) return undefined;
  let best: PackageRoot | null = null;
  for (const p of packages) {
    if ((source === p.name || source.startsWith(`${p.name}/`)) && (!best || p.name.length > best.name.length)) best = p;
  }
  if (best) return join(best.root, source.slice(best.name.length + 1));
  // `vendor/` of the module the importing file belongs to (the innermost root holding it).
  let own: PackageRoot | null = null;
  for (const p of packages) {
    if ((p.root === "" || importingFile.startsWith(`${p.root}/`)) && (!own || p.root.length > own.root.length)) own = p;
  }
  if (own) {
    const vendored = join(own.root, `vendor/${source}`);
    if (hasDirectory(vendored)) return vendored;
  }
  return null;
}
