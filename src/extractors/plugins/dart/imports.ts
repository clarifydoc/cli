import type { ImportInfo } from "../../../types/analysis.js";

/** A directive's start: `import 'x'`, `export "x"`, `part 'x'` (never `part of`). */
const DIRECTIVE = /^\s*(import|export|part)\s+(?=['"])/;
/** A conditional import's other branch: `if (dart.library.html) 'io_web.dart'`. */
const BRANCH = /\bif\s*\([^)]*\)\s*['"]([^'"]+)['"]/g;

/** Split a `show`/`hide`/`as` tail into its specifier identifiers. */
function importSpecifiers(tail: string): string[] {
  const specs: string[] = [];
  const asM = tail.match(/\bas\s+([A-Za-z_$]\w*)/);
  if (asM) specs.push(asM[1]!);
  for (const c of tail.matchAll(/\b(?:show|hide)\s+([A-Za-z_$][\w$,\s]*)/g)) {
    for (const id of c[1]!.split(",")) {
      const t = id.trim().split(/\s+/)[0];
      if (t) specs.push(t);
    }
  }
  return specs;
}

/**
 * Dart's `import` / `export` / `part` directives, each over as many lines as it
 * takes. An import without a prefix (`as p`) puts the library's top-level names
 * in scope (`inScope`: those `show` names, else all). Each branch of a
 * conditional import (`import 'io_stub.dart' if (dart.library.html)
 * 'io_web.dart'`) is an import; names resolve against the first, as the
 * analyzer reads them. A `part` shares one scope with its library
 * (`inScope.shared`): each sees the other's declarations and imports.
 */
export function extractDartImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]!);
    if (!m) continue;
    const kind = m[1]!;
    let text = lines[i]!.slice(m[0].length).replace(/\/\/.*$/, "");
    let j = i;
    while (!text.includes(";") && j + 1 < lines.length && j - i < 10) text += " " + lines[++j]!.replace(/\/\/.*$/, "");
    const statement = text.slice(0, text.includes(";") ? text.indexOf(";") : undefined);
    const first = /^(['"])([^'"]+)\1/.exec(statement.trimStart());
    if (!first) continue;
    const branches = [...statement.matchAll(BRANCH)].map((b) => b[1]!);
    // The prefix, `show` and `hide` come after the last URI.
    const lastUri = branches.at(-1) ?? first[2]!;
    const tail = statement.slice(statement.lastIndexOf(lastUri) + lastUri.length + 1);
    const specifiers = kind === "part" ? [] : importSpecifiers(tail);
    const show = /\bshow\s+([A-Za-z_$][\w$,\s]*)/.exec(tail)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean);
    const base = { specifiers, isDefault: false, isNamespace: false, isType: false, line: i + 1 };
    const scope: ImportInfo["inScope"] =
      kind === "part" ? { module: first[2]!, shared: true }
        : kind === "import" && !/\bas\s+[A-Za-z_$]/.test(tail) ? { module: first[2]!, ...(show?.length ? { names: show } : {}) }
          : undefined;
    out.push({ source: first[2]!, ...base, ...(scope ? { inScope: scope } : {}) });
    for (const branch of branches) out.push({ source: branch, ...base });
    i = j;
  }
  return out;
}
