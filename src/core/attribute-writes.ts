import type { ClassInfo, FieldWriteRow, FileAnalysis } from "../types/analysis.js";
import type { AttributeWriteSite } from "./symbol-linker.js";

/**
 * Attribute assignments the symbol linker found no setter for (`club.status = x`: `AttributeWriteSite`, the receiver
 * already typed as any call's is) become field writes where the receiver's class — or a base — declares the
 * attribute as a property. Run after the languages' project passes, which add the properties no class body writes
 * (an ActiveRecord model's schema columns): a write to a declared column is a write to that field, not a call. A class
 * without the property, or a receiver the linker could not type, states nothing.
 */
export function joinAttributeWrites(
  sites: readonly AttributeWriteSite[],
  analyses: readonly FileAnalysis[],
  include: (file: string) => boolean = () => true,
): FieldWriteRow[] {
  if (sites.length === 0) return [];
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const named = new Map<string, Array<{ cls: ClassInfo; file: string }>>();
  for (const a of analyses) for (const cls of a.classes) (named.get(cls.name) ?? named.set(cls.name, []).get(cls.name)!).push({ cls, file: a.filePath });
  const baseOf = (cls: ClassInfo, file: string): { cls: ClassInfo; file: string } | null => {
    if (!cls.extends) return null;
    const language = byFile.get(file)?.language;
    const all = (named.get(cls.extends) ?? []).filter((c) => byFile.get(c.file)?.language === language);
    const own = all.filter((c) => c.file === file);
    const pool = own.length > 0 ? own : all;
    return pool.length === 1 ? pool[0]! : null;
  };
  const rows: FieldWriteRow[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    if (!include(site.file)) continue;
    let at: { cls: ClassInfo; file: string } | null = { cls: byFile.get(site.typeFile)?.classes.find((c) => c.name === site.typeName)!, file: site.typeFile };
    for (let hop = 0; at?.cls && hop < 8; hop++) {
      if (at.cls.properties?.some((p) => p.name === site.member)) {
        const key = `${site.file}\0${site.function}\0${site.line}\0${site.member}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push({ class: at.cls.name, classFile: at.file, member: site.member, function: site.function, file: site.file, line: site.line, via: "typed" });
        }
        break;
      }
      at = baseOf(at.cls, at.file);
    }
  }
  return rows;
}
