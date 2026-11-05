/**
 * The class Java names a Kotlin file's top-level functions through: `<File>Kt` — the file name with its first letter
 * upper-cased and every character an identifier cannot hold turned into `_` — or what `@file:JvmName("Scoreboard")` says.
 * `@file:JvmMultifileClass` parts share that name; each part still declares its own functions.
 */
export function kotlinFacadeClass(sourceText: string, filePath: string): string | null {
  const named = /^\s*@file\s*:\s*(?:\[[^\]]*?)?\bJvmName\s*\(\s*(?:name\s*=\s*)?"([A-Za-z_$][\w$]*)"/m.exec(sourceText);
  if (named) return named[1]!;
  if (filePath.endsWith(".kts")) return null;
  const stem = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.kts?$/, "");
  if (!stem) return null;
  const ident = stem.replace(/[^A-Za-z0-9_$]/g, "_");
  return `${ident.charAt(0).toUpperCase()}${ident.slice(1)}Kt`;
}
