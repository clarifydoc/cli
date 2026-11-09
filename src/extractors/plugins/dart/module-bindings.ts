/**
 * The variables a Dart library declares at its top level, with the type each states: written
 * (`final SeasonTicket ticket = …;`, `late League league;`) or constructed by its initializer
 * (`final ticket = SeasonTicket();`, `const table = League<Club>();`). A function body sees them by bare name,
 * so the linker types `ticket.renew()` in a method by them when no local, parameter or field takes the name.
 *
 * Read off the lines `dart format` leaves at column 0, outside a block comment. An initializer that only calls
 * (`final ticket = SeasonTicket.load();` — a named constructor and a static method look alike) states nothing.
 */
import type { ModuleBindingInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";

const KEYWORDS = new Set([
  "abstract", "base", "class", "enum", "export", "extension", "external", "factory", "final", "const", "late", "var",
  "import", "interface", "library", "mixin", "part", "sealed", "typedef", "void", "dynamic", "static", "return",
]);

/** `final|const|var name = Type(…)`, `= const Type<…>(…)`, `= new Type(…)`. */
const CONSTRUCTED = /^(?:late\s+)?(?:final|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:const\s+|new\s+)?(_?[A-Z][\w$]*)\s*(?:<[^()=;]*>)?\s*\(/;

/** `[late] [final|const] Type name [= …];` — the type as written. */
const DECLARED = /^(?:late\s+)?(?:(?:final|const)\s+)?([A-Za-z_$][\w$.]*(?:<[^;=()]*>)?\??)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/;

export function dartModuleBindings(lines: readonly string[]): ModuleBindingInfo[] {
  const out = new Map<string, ModuleBindingInfo | null>();
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (inComment) {
      if (raw.includes("*/")) inComment = false;
      continue;
    }
    if (/^\/\*/.test(raw) && !raw.includes("*/")) {
      inComment = true;
      continue;
    }
    if (!/^[A-Za-z_$]/.test(raw)) continue;
    const code = blankStringLiterals(raw, ["//"]);
    let name: string | undefined;
    let type: string | undefined;
    const built = CONSTRUCTED.exec(code);
    if (built) {
      name = built[1];
      type = built[2];
    } else {
      const declared = DECLARED.exec(code);
      if (declared && !KEYWORDS.has(declared[1]!.replace(/[<?].*$/s, "")) && !KEYWORDS.has(declared[2]!)) {
        type = declared[1];
        name = declared[2];
      }
    }
    if (!name || !type) continue;
    // Declared twice (a conditional import's stub beside the real one): the name decides nothing.
    out.set(name, out.has(name) ? null : { name, type, line: i + 1, exported: !name.startsWith("_") });
  }
  return [...out.values()].filter((b): b is ModuleBindingInfo => b !== null);
}
