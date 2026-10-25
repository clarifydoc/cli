import type { TypeAliasInfo } from "../../../types/analysis.js";

const SINGLE = /^type\s+([A-Za-z_]\w*)\s*=\s*([*\w.[\]]+)\s*(?:\/\/.*)?$/;
const IN_BLOCK = /^\s+([A-Za-z_]\w*)\s*=\s*([*\w.[\]]+)\s*(?:\/\/.*)?$/;

/**
 * `type Repo = store.ClubRepo`, alone or inside a `type ( … )` block. A
 * defined type (`type Repo store.ClubRepo`, no `=`) is a new type without the
 * other's methods, so it is no alias.
 */
export function extractGoTypeAliases(lines: string[]): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  let inBlock = false;
  lines.forEach((line, i) => {
    if (inBlock) {
      if (/^\)/.test(line)) { inBlock = false; return; }
      const m = IN_BLOCK.exec(line);
      if (m) out.push({ name: m[1]!, type: m[2]!, line: i + 1 });
      return;
    }
    if (/^type\s*\(\s*$/.test(line)) { inBlock = true; return; }
    const m = SINGLE.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2]!, line: i + 1 });
  });
  return out;
}
