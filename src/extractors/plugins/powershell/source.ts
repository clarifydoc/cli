/**
 * PowerShell source with what is not code blanked — `<# … #>` comment blocks
 * (comment-based help: `.EXAMPLE Get-User -Id 5` is no call) and the body of
 * every `@"…"@` / `@'…'@` here-string (an SQL or JSON block). Line structure
 * and columns are kept, so line numbers stay true.
 */
export function blankPowerShellNonCode(source: string): string {
  if (!source.includes("<#") && !/@["']\s*\r?$/m.test(source)) return source;
  const blank = (s: string) => s.replace(/[^\n\r]/g, " ");
  const lines = source.replace(/<#[\s\S]*?#>/g, blank).split("\n");
  let here: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (here) {
      if (line.startsWith(here)) here = null;
      lines[i] = blank(line);
      continue;
    }
    const open = /@(["'])\s*\r?$/.exec(line);
    if (open) here = open[1] + "@";
  }
  return lines.join("\n");
}
