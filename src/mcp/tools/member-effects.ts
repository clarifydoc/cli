import type { ProjectAnalysis } from "../../types/analysis.js";
import { bulletList, loc, plural } from "../format.js";
import { noResults } from "../empty.js";

/**
 * What a function writes and throws (`ProjectAnalysis.fieldWrites` / `thrownTypes`), as lines for `clarifydoc_explain`.
 * Null when it states neither. `file` narrows to one definition when the name is declared in several files.
 */
export function functionEffectsText(summary: ProjectAnalysis, symbol: string, file?: string): string | null {
  const here = (r: { function: string; file: string }): boolean => (r.function === symbol || r.function.endsWith(`.${symbol}`)) && (!file || r.file === file);
  const writes = (summary.fieldWrites ?? []).filter(here);
  const throws = (summary.thrownTypes ?? []).filter(here);
  if (writes.length === 0 && throws.length === 0) return null;
  const lines: string[] = [];
  // One row per field or type and file, its lines together: four `throw new HttpException` sites are one fact.
  const grouped = <T extends { file: string; line: number }>(rows: readonly T[], key: (r: T) => string): Array<{ row: T; lines: number[] }> => {
    const by = new Map<string, { row: T; lines: number[] }>();
    for (const r of rows) {
      const k = `${key(r)}\0${r.file}`;
      const g = by.get(k);
      if (g) g.lines.push(r.line);
      else by.set(k, { row: r, lines: [r.line] });
    }
    return [...by.values()];
  };
  const at = (file: string, lines: number[]): string => (lines.length === 1 ? loc(file, lines[0]!) : `${file}:${lines.join(", ")}`);
  if (writes.length > 0) {
    lines.push(`Assigns ${plural(new Set(writes.map((w) => `${w.class}.${w.member}`)).size, "field")}:`);
    lines.push(...bulletList(grouped(writes, (w) => `${w.class}.${w.member}`), 12, ({ row: w, lines: ls }) => `${w.class}.${w.member} at ${at(w.file, ls)}${w.classFile !== w.file ? ` (declared in ${w.classFile})` : ""}`));
  }
  if (throws.length > 0) {
    lines.push(`Throws ${plural(new Set(throws.map((t) => t.type)).size, "exception type")}:`);
    lines.push(...bulletList(grouped(throws, (t) => `${t.type}\0${t.declared ? 1 : 0}`), 12, ({ row: t, lines: ls }) => `${t.type}${t.declared ? " (declared in the signature)" : ""} at ${at(t.file, ls)}${t.classFile ? ` — project class in ${t.classFile}` : ""}`));
  }
  return lines.join("\n");
}

/**
 * `clarifydoc_trace direction=writers`: who assigns `Class.field`, or — for a name with no member — who throws that
 * exception class. Direct statements only: a write through a call is the callee's.
 */
export function writersText(summary: ProjectAnalysis, symbol: string, limit: number, file?: string): string {
  const dot = symbol.lastIndexOf(".");
  const cls = dot > 0 ? symbol.slice(0, dot) : "";
  const member = dot > 0 ? symbol.slice(dot + 1) : "";
  const writes = dot > 0 ? (summary.fieldWrites ?? []).filter((w) => w.class === cls.slice(cls.lastIndexOf(".") + 1) && w.member === member && (!file || w.classFile === file)) : [];
  const thrown = (summary.thrownTypes ?? []).filter((t) => (t.type === symbol || t.type.endsWith(`.${symbol}`)) && (!file || t.classFile === file));
  if (writes.length === 0 && thrown.length === 0) {
    const members = [...new Set((summary.fieldWrites ?? []).map((w) => `${w.class}.${w.member}`))].sort();
    return noResults({
      headline: `No assignment to \`${symbol}\` and no throw of it is in the analysis.`,
      holds: `The analysis holds ${plural((summary.fieldWrites ?? []).length, "field assignment")} (${members.slice(0, 5).join(", ") || "none"}${members.length > 5 ? ", …" : ""}) and ${plural((summary.thrownTypes ?? []).length, "thrown type")}. ` +
        `Writes are stated for TypeScript/JavaScript, Java, Kotlin, C#, Python, PHP and Go, through \`this\`, a bare field or a receiver whose type is declared; a constructor's initializing writes are left out.`,
      next: [`clarifydoc_search query="${member || symbol}" — by name`],
    });
  }
  const lines: string[] = [];
  if (writes.length > 0) {
    const homes = [...new Set(writes.map((w) => w.classFile))];
    lines.push(`# Who assigns ${cls}.${member} — ${plural(writes.length, "write")} in ${plural(new Set(writes.map((w) => w.function)).size, "function")}`, "");
    if (homes.length > 1) lines.push(`Several classes are named ${cls} (${homes.join(", ")}); pass \`file\` to pick one.`, "");
    lines.push(...bulletList(writes, limit, (w) => `${w.function} — ${loc(w.file, w.line)}${w.via === "typed" ? " (through a typed receiver)" : ""}`));
  }
  if (thrown.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`# Who throws ${symbol} — ${plural(thrown.length, "site")}`, "");
    lines.push(...bulletList(thrown, limit, (t) => `${t.function} — ${loc(t.file, t.line)}${t.declared ? " (declared in the signature)" : ""}`));
  }
  return lines.join("\n");
}
