/**
 * A Delphi/Lazarus form and its unit are companions by basename: `Main.dfm`
 * (or `.lfm`, `.fmx`) belongs to `Main.pas` (or `.pp`). The stem is the join
 * key, lower-cased as Windows file systems compare.
 */
export function companionStem(file: string): string {
  return file.replace(/\.(?:dfm|lfm|fmx|pas|pp|dpr)$/i, "").toLowerCase();
}
