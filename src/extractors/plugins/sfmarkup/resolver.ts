import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { CONTROLLER_DECORATOR, EXTENSION_DECORATOR, VF_BINDING_TARGET } from "./index.js";

/**
 * Aura components and Visualforce pages → the code they name.
 *
 * - An Aura component is the folder `aura/clubList/`: `clubList.cmp`, `clubListController.js`, `clubListHelper.js`.
 *   `{!c.handleSave}` in the markup is the controller's function `handleSave`; a controller or renderer function's
 *   `helper.save(component)` is the helper's `save`; `component.get("c.promoteClub")` asks for the `@AuraEnabled` Apex
 *   method of the class the markup's `controller=` names (the script reader states it as a call to `aura-action:promoteClub`).
 * - A Visualforce page's `action="{!save}"` and the members its expressions read (`{!clubs}` → `getClubs`) are the methods of
 *   its `controller=` class and `extensions=` classes, extensions first, as the platform picks them.
 *
 * A class is found by name among the project's Apex files and only when one file declares it; a method must exist on it.
 */

const SOURCE_LANGUAGES: Language[] = ["sfmarkup", "javascript", "apex"];

function leaf(decorators: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (const d of decorators) {
    const m = new RegExp(`^${name}\\(([^)]*)\\)$`).exec(d);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

const lower = (s: string): string => s.toLowerCase();

export class SfMarkupResolver implements DispatchResolver {
  readonly id = "sf-markup";
  readonly languages: Language[] = SOURCE_LANGUAGES;
  readonly priority = 59;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const byPath = new Map<string, FileAnalysis>();
    const apexByClass = new Map<string, Array<{ file: FileAnalysis; cls: ClassInfo }>>();
    const pages: FileAnalysis[] = [];
    for (const a of analyses) {
      byPath.set(a.filePath, a);
      if (a.language === "sfmarkup") pages.push(a);
      else if (a.language === "apex") {
        for (const cls of a.classes) (apexByClass.get(lower(cls.name)) ?? apexByClass.set(lower(cls.name), []).get(lower(cls.name))!).push({ file: a, cls });
      }
    }
    if (pages.length === 0) return [];
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const add = (l: SymbolLink): void => {
      const key = `${l.sourceFile}\0${l.sourceSymbol}\0${l.sourceLine}\0${l.targetFile}\0${l.targetSymbol}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push(l);
    };
    const classOf = (name: string): { file: FileAnalysis; cls: ClassInfo } | null => {
      const hits = apexByClass.get(lower(name)) ?? [];
      return hits.length === 1 ? hits[0]! : null;
    };
    const memberOf = (found: { cls: ClassInfo }, ...names: string[]): FunctionInfo | undefined => {
      for (const n of names) {
        const m = found.cls.methods.find((x) => lower(x.name) === lower(n));
        if (m) return m;
      }
      return undefined;
    };
    const apexLink = (source: { file: string; symbol: string; line: number; call: string }, found: { file: FileAnalysis; cls: ClassInfo }, m: FunctionInfo, confidence: SymbolLink["confidence"]): void =>
      add({ sourceFile: source.file, sourceSymbol: source.symbol, sourceLine: source.line, callName: source.call, targetFile: found.file.filePath, targetSymbol: `${found.cls.name}.${m.name}`, targetLine: m.line, confidence });

    for (const page of pages) {
      const setup = page.functions.find((f) => f.name === "<setup>");
      const controller = setup ? leaf(setup.decorators, CONTROLLER_DECORATOR)[0] : undefined;
      const extensions = setup ? leaf(setup.decorators, EXTENSION_DECORATOR) : [];
      const isAura = page.screens?.[0]?.formType.startsWith("aura:") === true;

      if (isAura) {
        const m = /^(.*\/)?([^/]+)\.cmp$/.exec(page.filePath);
        if (!m) continue;
        const dir = m[1] ?? "";
        const stem = m[2]!;
        const script = (suffix: "Controller" | "Helper" | "Renderer"): FileAnalysis | undefined => byPath.get(`${dir}${stem}${suffix}.js`);
        const fnOf = (file: FileAnalysis | undefined, suffix: string, name: string): FunctionInfo | undefined => file?.functions.find((f) => f.name === `${stem}${suffix}.${name}`);
        const ctrl = script("Controller");
        for (const el of page.interactiveElements) {
          const fn = el.handler ? fnOf(ctrl, "Controller", el.handler) : undefined;
          if (!fn || !ctrl) continue;
          add({ sourceFile: page.filePath, sourceSymbol: "<component>", sourceLine: el.line, callName: el.handler!, targetFile: ctrl.filePath, targetSymbol: fn.name, targetLine: fn.line, confidence: "INFERRED" });
        }
        const apex = controller ? classOf(controller) : null;
        const helper = script("Helper");
        for (const [suffix, file] of [["Controller", ctrl], ["Helper", helper], ["Renderer", script("Renderer")]] as const) {
          if (!file) continue;
          for (const fn of file.functions) {
            for (const call of fn.calls) {
              const src = { file: file.filePath, symbol: fn.name, line: call.line, call: call.name };
              if (call.target?.startsWith("aura-action:")) {
                const method = apex ? memberOf(apex, call.target.slice("aura-action:".length)) : undefined;
                // Only a method the platform exposes to the component is a server action.
                if (apex && method && method.decorators.some((d) => /^auraenabled\b/i.test(d))) apexLink(src, apex, method, "EXTRACTED");
                continue;
              }
              const viaHelper = /^(?:helper|this)\.([A-Za-z_]\w*)$/.exec(call.name);
              if (!viaHelper || !helper) continue;
              // `this.x` is the helper's own member only inside the helper; in a controller `this` is no helper.
              if (call.name.startsWith("this.") && suffix !== "Helper") continue;
              const target = fnOf(helper, "Helper", viaHelper[1]!);
              if (target) add({ sourceFile: file.filePath, sourceSymbol: fn.name, sourceLine: call.line, callName: call.name, targetFile: helper.filePath, targetSymbol: target.name, targetLine: target.line, confidence: "INFERRED" });
            }
          }
        }
        continue;
      }

      // Visualforce: extensions first, then the controller.
      const classes = [...extensions, ...(controller ? [controller] : [])].map(classOf).filter((c): c is { file: FileAnalysis; cls: ClassInfo } => c !== null);
      if (classes.length === 0) continue;
      const pick = (name: string, getter: boolean): { found: { file: FileAnalysis; cls: ClassInfo }; method: FunctionInfo } | null => {
        for (const found of classes) {
          const method = memberOf(found, ...(getter ? [`get${name}`] : [name]));
          if (method) return { found, method };
        }
        return null;
      };
      for (const el of page.interactiveElements) {
        const hit = el.handler ? pick(el.handler, false) : null;
        if (hit) apexLink({ file: page.filePath, symbol: "<component>", line: el.line, call: el.handler! }, hit.found, hit.method, "INFERRED");
      }
      for (const call of setup?.calls ?? []) {
        if (!call.target?.startsWith(VF_BINDING_TARGET)) continue;
        const hit = pick(call.name, true) ?? pick(call.name, false);
        if (hit) apexLink({ file: page.filePath, symbol: "<setup>", line: call.line, call: call.name }, hit.found, hit.method, "INFERRED");
      }
    }
    return links;
  }
}

export const sfmarkupResolvers: readonly DispatchResolver[] = [new SfMarkupResolver()];
