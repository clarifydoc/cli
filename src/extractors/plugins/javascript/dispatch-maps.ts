import type { Node } from "web-tree-sitter";

/** A plain or dotted name (`saveClub`, `clubs.loadLatest`), never an `undefined`/`null`-like literal. */
const NAMED_VALUE = /^(?!undefined$|null$|true$|false$)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Expressions that only parenthesize or type what they hold (`{ … } as const`, `satisfies Record<…>`). */
const TYPE_WRAPPERS = new Set(["parenthesized_expression", "satisfies_expression", "as_expression", "type_assertion"]);

/** Object members a dispatch map may hold besides named values: functions written in place. */
const INLINE_FUNCTIONS = new Set(["arrow_function", "function_expression", "generator_function"]);

/** One value of a dispatch map: the node naming a function, and the key it is held under. */
export interface DispatchMapEntry {
  value: Node;
  key: string;
}

/**
 * The entries of a dispatch map a declarator binds: `const ACTIONS = { save: saveClub, list:
 * clubs.loadMatches, remove }` → `save` → `saveClub`, `list` → `clubs.loadMatches`, `remove` →
 * `remove`. Only a `const` holding an object literal whose every member names a value or is a
 * function written in place — an object holding a literal, a spread or a nested object is data,
 * not a map. Whether a value is a function is the linker's to say.
 */
export function dispatchMapEntries(declarator: Node): { holder: string; entries: DispatchMapEntry[] } | null {
  if (declarator.type !== "variable_declarator") return null;
  const decl = declarator.parent;
  if (decl?.type !== "lexical_declaration" || decl.child(0)?.type !== "const") return null;
  const name = declarator.childForFieldName("name");
  let value = declarator.childForFieldName("value");
  while (value && TYPE_WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
  if (name?.type !== "identifier" || value?.type !== "object") return null;
  const entries: DispatchMapEntry[] = [];
  for (const member of value.namedChildren) {
    if (member.type === "comment" || member.type === "method_definition") continue;
    if (member.type === "shorthand_property_identifier") {
      entries.push({ value: member, key: member.text });
      continue;
    }
    if (member.type !== "pair") return null;
    const key = member.childForFieldName("key");
    const held = member.childForFieldName("value");
    if (!key || !held) return null;
    if (INLINE_FUNCTIONS.has(held.type)) continue;
    if ((held.type !== "identifier" && held.type !== "member_expression") || !NAMED_VALUE.test(held.text)) return null;
    const keyText = key.type === "string" ? key.text.slice(1, -1) : key.text;
    entries.push({ value: held, key: keyText });
  }
  return entries.length > 0 ? { holder: name.text, entries } : null;
}

let mapsTree: Node["tree"] | null = null;
let mapNames = new Set<string>();

/** The names the file binds to dispatch maps, in any scope (read once per tree). */
function dispatchMapNames(node: Node): ReadonlySet<string> {
  if (node.tree === mapsTree) return mapNames;
  mapsTree = node.tree;
  mapNames = new Set();
  for (const d of node.tree.rootNode.descendantsOfType("variable_declarator")) {
    const map = d ? dispatchMapEntries(d) : null;
    if (map) mapNames.add(map.holder);
  }
  return mapNames;
}

let importsTree: Node["tree"] | null = null;
let importNames = new Set<string>();

/** The names the file imports (`import { ACTIONS }`, `import ACTIONS`, `{ a as ACTIONS }`), read once per tree. */
function importedNames(node: Node): ReadonlySet<string> {
  if (node.tree === importsTree) return importNames;
  importsTree = node.tree;
  importNames = new Set();
  for (const stmt of node.tree.rootNode.namedChildren) {
    if (stmt.type !== "import_statement") continue;
    for (const spec of stmt.descendantsOfType(["import_specifier", "identifier"])) {
      if (!spec) continue;
      if (spec.type === "import_specifier") {
        const local = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
        if (local) importNames.add(local.text);
      } else if (spec.parent?.type === "import_clause") importNames.add(spec.text);
    }
  }
  return importNames;
}

/**
 * The call name of a function read out of a dispatch map: `ACTIONS["save"]()` → `ACTIONS.save`,
 * `ACTIONS[kind]()` → `ACTIONS[]` (any of its values). The map is one the file declares, or a name
 * it imports — whether that is a map is the linker's to say, from the exporting file. Null for any
 * other subscript callee — an array element.
 */
export function dispatchMapCallee(callee: Node): string | null {
  if (callee.type !== "subscript_expression") return null;
  const object = callee.childForFieldName("object");
  if (object?.type !== "identifier" || !(dispatchMapNames(callee).has(object.text) || importedNames(callee).has(object.text))) return null;
  const index = callee.childForFieldName("index");
  if (index?.type === "string" && /^["'][A-Za-z_$][\w$]*["']$/.test(index.text)) return `${object.text}.${index.text.slice(1, -1)}`;
  return `${object.text}[]`;
}
