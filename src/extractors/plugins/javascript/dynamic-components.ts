import type { FileAnalysis } from "../../../types/analysis.js";
import { objectEntries, objectLiteral } from "./bound-listeners.js";

/** Most components one dynamic tag may stand for. */
const MAX_CANDIDATES = 8;

/**
 * `<component :is="Map[type]" @delete="remove">`: the tag names no component, the script's literal map does —
 * each value of `const Map = { text: TextField, date: DateField }` is a component the tag may render (also
 * `:is="wide ? WideCard : NarrowCard"` and `:is="Card"`). Each candidate is a component the file uses
 * (`subComponents`, when it imports it), and the bindings on the tag are bound on each
 * (`InteractiveElementInfo.componentCandidates`): the child that emits the event fires the parent's handler.
 * A candidate the script does not state as a bare imported name, or a map with a value that is not one, gives none.
 */
export function addDynamicComponents(analysis: FileAnalysis, template: string, raw: string, script: string): void {
  if (!/<component\b/.test(template)) return;
  const templateStart = raw.indexOf(template);
  const tagRegex = /<component\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g;
  for (let tag = tagRegex.exec(template); tag; tag = tagRegex.exec(template)) {
    const is = /(?:^|\s)(?::is|v-bind:is)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[1] ?? "");
    if (!is) continue;
    const names = candidatesOf((is[1] ?? is[2]!).trim(), script);
    if (!names || names.length === 0 || names.length > MAX_CANDIDATES) continue;
    const line = (raw.slice(0, templateStart + tag.index).match(/\n/g)?.length ?? 0) + 1;
    const known = names.filter((n) => analysis.imports.some((i) => i.specifiers.includes(n)));
    if (known.length !== names.length) continue;
    for (const el of analysis.interactiveElements) {
      if (el.element === "custom" && el.component === "component" && el.line === line) el.componentCandidates = names;
    }
    for (const name of names) {
      if (analysis.subComponents.some((s) => s.name === name)) continue;
      const importSource = analysis.imports.find((i) => i.specifiers.includes(name))?.source ?? null;
      analysis.subComponents.push({ name, importSource, props: [], line });
    }
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The component names an `:is` expression can take, or null when any is not a name the script states. */
function candidatesOf(expr: string, script: string): string[] | null {
  const ternary = /^[^?]+\?\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(expr);
  if (ternary) return [...new Set([ternary[1]!, ternary[2]!])];
  const indexed = /^([A-Za-z_$][\w$]*)\s*(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)$/.exec(expr);
  if (indexed) {
    const body = objectLiteral(script, indexed[1]!);
    if (body === undefined) return null;
    const out: string[] = [];
    for (const entry of objectEntries(body)) {
      if (!entry.trim()) continue;
      const m = /^\s*(?:['"]?[\w$-]+['"]?|\[[^\]]+\])\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry) ?? /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry);
      if (!m) return null;
      out.push(m[1]!);
    }
    return [...new Set(out)];
  }
  return IDENT.test(expr) && /^[A-Z]/.test(expr) ? [expr] : null;
}
