import type { ImportInfo } from "../../../types/analysis.js";

/** One import spec: an optional name (`alias`, `_`, `.`) and the quoted path. */
const SPEC = /^\s*(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/;
const SINGLE = /^\s*import\s+(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/;
const BLOCK_OPEN = /^\s*import\s*\(/;

/**
 * Go imports: `import "fmt"`, `import pr "app/routers/api/packages"`, and
 * every entry of an `import ( … )` block — bare, aliased, blank (`_`) or
 * dot-imported. Only inside an import declaration: a line that merely starts
 * with a string (`"application/json",` in a slice literal) is not one.
 *
 * Specifiers name the package as the file refers to it — the alias when one
 * is given (`packages_router.CommonRoutes()`), else the path's last segment;
 * a blank import binds nothing.
 */
export function extractGoImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const push = (name: string | undefined, source: string, line: number) => {
    const specifiers = name === "_" ? [] : name && name !== "." ? [name] : [source.slice(source.lastIndexOf("/") + 1)];
    out.push({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line });
  };
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    if (inBlock) {
      if (/^\s*\)/.test(line)) {
        inBlock = false;
        continue;
      }
      const m = SPEC.exec(line);
      if (m) push(m[1], m[2]!, i + 1);
      continue;
    }
    const single = SINGLE.exec(line);
    if (single) {
      push(single[1], single[2]!, i + 1);
      continue;
    }
    if (BLOCK_OPEN.test(line)) {
      // `import ("fmt")` on one line, or the block's first entry after `(`.
      const rest = line.slice(line.indexOf("(") + 1);
      const m = SPEC.exec(rest);
      if (m) push(m[1], m[2]!, i + 1);
      inBlock = !/\)\s*$/.test(rest);
    }
  }
  return out;
}
