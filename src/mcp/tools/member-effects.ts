import type { ProjectAnalysis } from "../../types/analysis.js";
import { bulletList, loc, plural } from "../format.js";
import { noResults } from "../empty.js";
import { symbolAnswersTo } from "../../core/owner-paths.js";

/**
 * The rows of `Class.member` a person typed: a class id that ends in the typed class path (`Left.Builder` answers
 * `Builder` and `Left.Builder`), else, for a path with a namespace in front (`League.Match.score`), the class's last
 * segment. A summary written earlier holds plain labels, which the second rule reads.
 */
function inClass<T extends { class: string }>(rows: readonly T[], cls: string): T[] {
  const want = cls.toLowerCase();
  const path = rows.filter((r) => symbolAnswersTo(r.class, want));
  if (path.length > 0) return path;
  const last = cls.slice(cls.lastIndexOf(".") + 1);
  return rows.filter((r) => r.class === last);
}

/**
 * What a function writes, reads and throws (`ProjectAnalysis.fieldWrites` / `fieldReads` / `thrownTypes`), as lines for `clarifydoc_explain`.
 * Null when it states neither. `file` narrows to one definition when the name is declared in several files.
 */
export function functionEffectsText(summary: ProjectAnalysis, symbol: string, file?: string): string | null {
  // A typed overload id (`Squad.Pick(int)`) answers to one overload; the name finds every overload.
  const want = symbol.toLowerCase();
  const here = (r: { function: string; file: string }): boolean => symbolAnswersTo(r.function, want) && (!file || r.file === file);
  const writes = (summary.fieldWrites ?? []).filter(here);
  const throws = (summary.thrownTypes ?? []).filter(here);
  const reads = (summary.fieldReads ?? []).filter(here);
  if (writes.length === 0 && throws.length === 0 && reads.length === 0) return null;
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
  if (reads.length > 0) {
    // One line: reads are many and sit in the function's own file, so a line number is the location; where a
    // property is declared is `trace direction=readers` of it.
    const read = grouped(reads, (r) => `${r.class}.${r.member}`);
    const shown = read.slice(0, 12).map(({ row: r, lines: ls }) => `${r.class}.${r.member} (:${ls.join(", ")})`);
    lines.push(`Reads: ${shown.join(", ")}${read.length > shown.length ? `, +${read.length - shown.length} more` : ""}`);
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
  const writes = dot > 0 ? inClass((summary.fieldWrites ?? []).filter((w) => w.member === member && (!file || w.classFile === file)), cls) : [];
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

/**
 * `clarifydoc_trace direction=readers`: who reads `Class.property` — one row per reading function (its first read), through
 * `this`, a typed receiver or a field of a declared class. A read in a function with no declared receiver type states nothing.
 */
export function readersText(summary: ProjectAnalysis, symbol: string, limit: number, file?: string): string {
  const dot = symbol.lastIndexOf(".");
  const cls = dot > 0 ? symbol.slice(0, dot) : "";
  const member = dot > 0 ? symbol.slice(dot + 1) : "";
  const reads = dot > 0 ? inClass((summary.fieldReads ?? []).filter((r) => r.member === member && (!file || r.classFile === file)), cls) : [];
  if (reads.length === 0) {
    const all = summary.fieldReads ?? [];
    const members = [...new Set(all.map((r) => `${r.class}.${r.member}`))].sort();
    return noResults({
      headline: `No read of \`${symbol}\` is in the analysis.`,
      holds: `The analysis holds ${plural(all.length, "property read")} (${members.slice(0, 5).join(", ") || "none"}${members.length > 5 ? ", …" : ""}). ` +
        `Reads are stated for TypeScript/JavaScript, Java, Kotlin, C#, Python and PHP, through \`this\`, \`this.field\` or a receiver whose type is declared, ` +
        `where a project class declares the property; a method call and a plain assignment are not reads.`,
      next: [`clarifydoc_trace symbol="${symbol}" direction="writers" — who assigns it`, `clarifydoc_search query="${member || symbol}" — by name`],
    });
  }
  const homes = [...new Set(reads.map((r) => r.classFile))];
  const lines = [`# Who reads ${cls}.${member} — ${plural(new Set(reads.map((r) => r.function)).size, "function")}`, ""];
  if (homes.length > 1) lines.push(`Several classes are named ${cls} (${homes.join(", ")}); pass \`file\` to pick one.`, "");
  lines.push(...bulletList(reads, limit, (r) => `${r.function} — ${loc(r.file, r.line)}${r.via === "typed" ? " (through a typed receiver)" : ""}`));
  return lines.join("\n");
}
