import type { Node, Tree } from "web-tree-sitter";
import type { CallInfo, FunctionPropBinding, ImportInfo } from "../../../types/analysis.js";
import { dispatchMapEntries } from "./dispatch-maps.js";
import { importedBinding } from "./library-callbacks.js";

/**
 * A project dispatch map handed down as a prop: `const ACTIONS = { save: saveClub, remove: removeClub }` with
 * `<ClubTable :actions="ACTIONS" />` / `<ClubTable actions={ACTIONS} />`. The child calls its members —
 * `props.actions.save(row)`, `actions.save(row)` in its template — so each held function is a function prop of its
 * own (`actions.save`), which the prop-callback resolver joins to the child's calls of it, through the same
 * expansion as a table handed down (`library-callbacks.ts`). A handler the file imports says where from
 * (`FunctionPropBinding.handlerImport`); whether a value is a function is the resolver's to say, as for the map's own calls.
 */

/** One function a dispatch map holds under a key. */
export interface MapHeld {
  key: string;
  name: string;
  handlerImport?: { source: string; name: string };
}

/** The key of an entry the plugin keeps as its own function property: `ACTIONS.save`, never `items[].run` or a path. */
const SINGLE_KEY = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

/** The module a named import of `name` comes from, in the file's import list. */
function importOfName(imports: readonly ImportInfo[], name: string): { source: string; name: string } | undefined {
  for (const imp of imports) {
    if (imp.isType || imp.executes || imp.isDefault || imp.isNamespace || !imp.specifiers.includes(name)) continue;
    return { source: imp.source, name: imp.aliases?.[name] ?? name };
  }
  return undefined;
}

/**
 * The dispatch maps a file's functions hold, from their `property` calls (`CallInfo.returnedAs` `ACTIONS.save`):
 * holder → the functions held under each key. What a library runs (`libraryOption`) is not a map.
 */
export function dispatchMapHoldersOf(functions: ReadonlyArray<{ calls: readonly CallInfo[] }>, imports: readonly ImportInfo[]): Map<string, MapHeld[]> {
  const out = new Map<string, MapHeld[]>();
  for (const fn of functions) {
    for (const c of fn.calls) {
      if (c.passed !== "property" || c.libraryOption || !c.returnedAs || !PLAIN_NAME.test(c.name)) continue;
      const m = SINGLE_KEY.exec(c.returnedAs);
      if (!m) continue;
      const list = out.get(m[1]!) ?? out.set(m[1]!, []).get(m[1]!)!;
      if (list.some((h) => h.key === m[2] && h.name === c.name)) continue;
      const handlerImport = importOfName(imports, c.name);
      list.push({ key: m[2]!, name: c.name, ...(handlerImport ? { handlerImport } : {}) });
    }
  }
  return out;
}

/** A binding of a map handed to a child (`:actions="ACTIONS"`) as one function prop per held function (`actions.save`). */
export function dispatchMapProps(bindings: readonly FunctionPropBinding[], heldOf: (holder: string) => readonly MapHeld[] | undefined): FunctionPropBinding[] {
  const out: FunctionPropBinding[] = [];
  for (const b of bindings) {
    for (const h of heldOf(b.handler) ?? []) {
      out.push({ component: b.component, prop: `${b.prop}.${h.key}`, handler: h.name, line: b.line, ...(h.handlerImport ? { handlerImport: h.handlerImport } : {}) });
    }
  }
  return out;
}

/**
 * The functions of the dispatch map a name is where it is used in script (`<ClubTable actions={ACTIONS} />`): the
 * `const` declaring it in an enclosing block or at the top level, when that declares a dispatch map.
 */
export function dispatchMapAt(site: Node, name: string, namesFunction: (site: Node, name: string) => boolean): MapHeld[] | null {
  for (let p = site.parent; p; p = p.parent) {
    if (p.type !== "statement_block" && p.type !== "program") continue;
    for (const stmt of p.namedChildren) {
      const decl = stmt?.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
      if (decl?.type !== "lexical_declaration") continue;
      for (const d of decl.namedChildren) {
        if (d?.type !== "variable_declarator" || d.childForFieldName("name")?.text !== name) continue;
        const map = dispatchMapEntries(d);
        if (!map) return null;
        const out: MapHeld[] = [];
        for (const e of map.entries) {
          if (!PLAIN_NAME.test(e.value.text) || !namesFunction(e.value, e.value.text)) continue;
          const imp = importedAs(e.value.tree, e.value.text);
          out.push({ key: e.key, name: e.value.text, ...(imp ? { handlerImport: imp } : {}) });
        }
        return out;
      }
    }
  }
  return null;
}

function importedAs(tree: Tree, local: string): { source: string; name: string } | undefined {
  const imp = importedBinding(tree, local);
  return imp && imp.imported !== "default" ? { source: imp.source, name: imp.imported } : undefined;
}
