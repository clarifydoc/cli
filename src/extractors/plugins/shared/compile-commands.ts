/**
 * A compilation database (`compile_commands.json`): per translation unit the directories its compiler searches for
 * an `#include` and the macros its command line sets. Leaf module (a static manifest imports it): a pure parser,
 * paths left as written — core joins them with the entry's own `directory` and maps them into the project.
 */
import type { CompileUnit } from "../../../types/language-plugin.js";

/** A shell command line as its words (quotes and backslash escapes resolved). */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let open = false;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length && /["\\$`]/.test(command[i + 1]!)) word += command[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      open = true;
    } else if (/\s/.test(ch)) {
      if (open || word) words.push(word);
      word = "";
      open = false;
    } else {
      word += ch;
      open = true;
    }
  }
  if (open || word) words.push(word);
  return words;
}

/** The include directories and macros one compiler command line states. */
export function readFlags(words: readonly string[]): Pick<CompileUnit, "quoteDirs" | "includeDirs" | "systemDirs" | "macros"> {
  const quoteDirs: string[] = [];
  const includeDirs: string[] = [];
  const systemDirs: string[] = [];
  const macros: CompileUnit["macros"] = [];
  // A flag whose value may be the next word (`-I dir`) or glued (`-Idir`).
  const valued: Array<[string, (v: string) => void]> = [
    ["-isystem", (v) => systemDirs.push(v)],
    ["-idirafter", (v) => systemDirs.push(v)],
    ["-iquote", (v) => quoteDirs.push(v)],
    ["-I", (v) => includeDirs.push(v)],
    ["-D", (v) => {
      const eq = v.indexOf("=");
      macros.push(eq < 0 ? { name: v, value: "1" } : { name: v.slice(0, eq), value: v.slice(eq + 1) });
    }],
    ["-U", (v) => macros.push({ name: v, undefined: true })],
  ];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    for (const [flag, take] of valued) {
      if (w === flag) {
        if (i + 1 < words.length) take(words[++i]!);
        break;
      }
      // `-isystem` must not be read as `-I` + junk, nor `-iquote` as anything: only an exact prefix of a short flag.
      if (flag.length === 2 && w.startsWith(flag) && !w.startsWith("-isystem") && !w.startsWith("-iquote") && !w.startsWith("-idirafter")) {
        take(w.slice(2));
        break;
      }
    }
  }
  return { quoteDirs, includeDirs, systemDirs, macros: macros.filter((m) => /^[A-Za-z_]\w*$/.test(m.name)) };
}

/** The translation units a `compile_commands.json` lists; an unreadable file or entry yields none. */
export function parseCompileCommands(text: string): CompileUnit[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CompileUnit[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { file?: unknown; directory?: unknown; command?: unknown; arguments?: unknown };
    if (typeof e.file !== "string") continue;
    const words = Array.isArray(e.arguments) ? e.arguments.filter((a): a is string => typeof a === "string") : typeof e.command === "string" ? splitCommand(e.command) : null;
    if (!words) continue;
    out.push({ file: e.file, directory: typeof e.directory === "string" ? e.directory : "", ...readFlags(words) });
  }
  return out;
}
