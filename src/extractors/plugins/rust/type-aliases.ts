import type { TypeAliasInfo } from "../../../types/analysis.js";

const ALIAS = /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)(?:<[^=]*>)?\s*=\s*([^;]+);/;

/** `type Repo = Arc<dyn ClubStore>;` (any visibility, generic aliases too); core unwraps the wrapper. */
export function extractRustTypeAliases(lines: string[]): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  lines.forEach((line, i) => {
    // An associated type inside a trait/impl (`type Output = Club;`) is indented; only module-level aliases.
    if (/^\s/.test(line) && !/^\s*pub/.test(line)) return;
    const m = ALIAS.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2]!.trim(), line: i + 1 });
  });
  return out;
}
