import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";

/**
 * Vuex: `store.dispatch('contacts/get')` runs the `get` action of the store
 * module registered as `contacts`. The two sides share only that string, so a
 * click whose handler dispatches stopped one hop short of the action — and of
 * the API call and the route and table behind it.
 *
 * Facts, per file:
 *   - `CallInfo.key` on a dispatch with a literal name (call-hooks.ts);
 *   - `FileAnalysis.storeModules` for `modules: { contacts, articles: helpCenterArticles }`
 *     in `createStore({…})` / `new Vuex.Store({…})` or in a module's own definition.
 *
 * The join walks the namespace from the root store: `a/b/act` → the root's
 * module `a` (its import) → that file's module `b` → action `act`, defined as
 * `actions.act` in the module file or a file it imports (`import { actions } from
 * './actions'`). A key without a namespace names a root action or a module that
 * is not namespaced; it joins only when exactly one store file defines it.
 */

const STORE_FACTORY_RE = /\b(?:createStore|Vuex\.Store|Store)\s*\(/;

export function extractStoreModules(tree: Tree, sourceText: string): Array<{ name: string; ref: string; line: number }> {
  if (!sourceText.includes("modules")) return [];
  const out: Array<{ name: string; ref: string; line: number }> = [];
  for (const pair of tree.rootNode.descendantsOfType("pair")) {
    if (keyText(pair) !== "modules") continue;
    const value = pair.childForFieldName("value");
    if (value?.type !== "object") continue;
    if (!isStoreDefinition(pair.parent)) continue;
    for (const entry of value.namedChildren) {
      if (entry.type === "shorthand_property_identifier") {
        out.push({ name: entry.text, ref: entry.text, line: entry.startPosition.row + 1 });
      } else if (entry.type === "pair") {
        const name = keyText(entry);
        const ref = entry.childForFieldName("value");
        if (name && ref?.type === "identifier") out.push({ name, ref: ref.text, line: entry.startPosition.row + 1 });
      }
    }
  }
  return out;
}

/** The object holding `modules:` is a store (`createStore({…})`) or a module (`{ namespaced, state, actions, … }`). */
function isStoreDefinition(obj: Node | null): boolean {
  if (obj?.type !== "object") return false;
  const call = obj.parent?.type === "arguments" ? obj.parent.parent : null;
  if (call && (call.type === "call_expression" || call.type === "new_expression")) {
    const callee = (call.childForFieldName("function") ?? call.childForFieldName("constructor"))?.text ?? "";
    if (STORE_FACTORY_RE.test(`${callee}(`)) return true;
  }
  const keys = new Set(obj.namedChildren.map((c) => (c.type === "pair" ? keyText(c) : c.type === "shorthand_property_identifier" ? c.text : null)));
  return keys.has("namespaced") || (keys.has("state") && (keys.has("actions") || keys.has("mutations") || keys.has("getters")));
}

function keyText(pair: Node): string | null {
  const key = pair.childForFieldName("key");
  return key ? key.text.replace(/^['"]|['"]$/g, "") : null;
}

export class VuexDispatchResolver implements DispatchResolver {
  readonly id = "vuex-action";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 31;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const registering = analyses.filter((a) => a.storeModules?.length);
    if (registering.length === 0) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));

    /** `name` registered in `a` → the module file. */
    const moduleFile = (a: FileAnalysis, name: string): FileAnalysis | null => {
      const reg = a.storeModules?.find((m) => m.name === name);
      if (!reg) return null;
      const imp = a.imports.find((i) => i.specifiers.includes(reg.ref));
      const file = imp ? resolveTarget(imp.source, a.filePath, filePathMap) : null;
      return file ? byPath.get(file) ?? null : null;
    };
    // Module files: registered by someone. Root stores: register modules but nobody registers them.
    const registered = new Set<string>();
    for (const a of registering) for (const m of a.storeModules!) {
      const f = moduleFile(a, m.name);
      if (f) registered.add(f.filePath);
    }
    const roots = registering.filter((a) => !registered.has(a.filePath));

    /** The `actions.<act>` a module file defines, there or in a file it imports. */
    const actionIn = (mod: FileAnalysis, act: string): { file: FileAnalysis; fn: FunctionInfo } | null => {
      const files = [mod, ...mod.imports.map((i) => resolveTarget(i.source, mod.filePath, filePathMap)).flatMap((f) => (f && byPath.get(f) ? [byPath.get(f)!] : []))];
      for (const f of files) {
        const fn = f.functions.find((x) => x.name === `actions.${act}` || x.name.endsWith(`.actions.${act}`));
        if (fn) return { file: f, fn };
      }
      return null;
    };

    const resolveKey = (key: string): { file: FileAnalysis; fn: FunctionInfo } | null => {
      const parts = key.split("/").filter(Boolean);
      const act = parts.pop();
      if (!act) return null;
      if (parts.length === 0) {
        // Un-namespaced: exactly one store file defines it.
        const hits = [...roots, ...[...registered].map((p) => byPath.get(p)!)].map((m) => actionIn(m, act)).filter((h): h is NonNullable<typeof h> => !!h);
        const unique = new Set(hits.map((h) => `${h.file.filePath}#${h.fn.line}`));
        return unique.size === 1 ? hits[0]! : null;
      }
      let found: { file: FileAnalysis; fn: FunctionInfo } | null = null;
      for (const root of roots) {
        let mod: FileAnalysis | null = root;
        for (const ns of parts) mod = mod ? moduleFile(mod, ns) : null;
        const hit = mod ? actionIn(mod, act) : null;
        if (!hit) continue;
        if (found && (found.file !== hit.file || found.fn !== hit.fn)) return null; // two stores disagree
        found = hit;
      }
      return found;
    };

    const links: SymbolLink[] = [];
    const memo = new Map<string, ReturnType<typeof resolveKey>>();
    for (const a of analyses) {
      const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls) {
          if (!call.key || !/(?:^|\.)dispatch$/.test(call.name)) continue;
          if (!memo.has(call.key)) memo.set(call.key, resolveKey(call.key));
          const hit = memo.get(call.key);
          if (!hit) continue;
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: `dispatch:${call.key}`,
            targetFile: hit.file.filePath,
            targetSymbol: hit.fn.name,
            targetLine: hit.fn.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
