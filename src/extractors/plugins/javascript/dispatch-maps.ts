import type { Node } from "web-tree-sitter";
import type { CallArgOrigin } from "../../../types/analysis.js";
import { expressionOrigin } from "./arg-origins.js";

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
let projectImportNames = new Set<string>();

/** The names the file imports (`import { ACTIONS }`, `import ACTIONS`, `{ a as ACTIONS }`), read once per tree. */
function importedNames(node: Node): ReadonlySet<string> {
  if (node.tree === importsTree) return importNames;
  importsTree = node.tree;
  importNames = new Set();
  projectImportNames = new Set();
  for (const stmt of node.tree.rootNode.namedChildren) {
    if (stmt.type !== "import_statement") continue;
    const source = stmt.childForFieldName("source")?.text.slice(1, -1) ?? "";
    // A project file (relative, or through an alias), never a package: `lodash`'s `_.map` is no project's map.
    const local = /^(?:\.{1,2}\/|[@~#]\/)/.test(source);
    const add = (name: string) => {
      importNames.add(name);
      if (local) projectImportNames.add(name);
    };
    for (const spec of stmt.descendantsOfType(["import_specifier", "identifier"])) {
      if (!spec) continue;
      if (spec.type === "import_specifier") {
        const bound = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
        if (bound) add(bound.text);
      } else if (spec.parent?.type === "import_clause") add(spec.text);
    }
  }
  return importNames;
}

/**
 * Whether a call `ACTIONS.map(…)` reads a key off a name the file imports from the project: the key may be
 * an own property of an object literal the exporting file declares, however much its leaf looks like an array
 * method. Only the linker can tell (it reads the exporting file's map), so the call is kept marked
 * `CallInfo.mapMember` and links nowhere else.
 */
export function importedMapMember(callName: string, node: Node): boolean {
  const dot = callName.indexOf(".");
  if (dot <= 0 || callName.indexOf(".", dot + 1) >= 0) return false;
  importedNames(node);
  return projectImportNames.has(callName.slice(0, dot));
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

/**
 * Whether a call `ACTIONS.send(…)` names a key the file's own dispatch map holds (`const ACTIONS = { send: sendClub }`):
 * the key is the map's, however much its leaf looks like a promise or array method.
 */
export function dispatchMapMember(callName: string, node: Node): boolean {
  const dot = callName.indexOf(".");
  if (dot <= 0 || callName.indexOf(".", dot + 1) >= 0) return false;
  const holder = callName.slice(0, dot);
  if (!dispatchMapNames(node).has(holder)) return false;
  const key = callName.slice(dot + 1);
  for (const d of node.tree.rootNode.descendantsOfType("variable_declarator")) {
    const map = d ? dispatchMapEntries(d) : null;
    if (map?.holder === holder && map.entries.some((e) => e.key === key)) return true;
  }
  return false;
}

/** A computed key that is no lookup of a fixed name: `stores[props.kind]`, `stores[kind]` — never `stores["club"]` or `stores[0]`. */
function runtimeIndex(index: Node | null): boolean {
  return !!index && index.type !== "string" && index.type !== "number" && index.type !== "template_string";
}

/**
 * A record of call results: `const stores = { [Kind.Club]: useClubStore(), [Kind.Player]: usePlayerStore() }`
 * — a `const` object literal whose every member holds a call (`useClubStore()`, `api.useClubs(slug)`), under
 * any key. A lookup in it at run time (`stores[props.kind]`) is the result of whichever call the key picks:
 * the linker fans a call on it out to each (`localTypes` `stores[]`, one entry per call).
 */
export function recordEntries(declarator: Node): { holder: string; calls: Node[]; keys: Array<string | null> } | null {
  if (declarator.type !== "variable_declarator") return null;
  const decl = declarator.parent;
  if (decl?.type !== "lexical_declaration" || decl.child(0)?.type !== "const") return null;
  const name = declarator.childForFieldName("name");
  let value = declarator.childForFieldName("value");
  while (value && TYPE_WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
  if (name?.type !== "identifier" || value?.type !== "object") return null;
  const calls: Node[] = [];
  const keys: Array<string | null> = [];
  for (const member of value.namedChildren) {
    if (member.type === "comment") continue;
    if (member.type !== "pair") return null;
    keys.push(entryKey(member.childForFieldName("key")));
    let held = member.childForFieldName("value");
    while (held && TYPE_WRAPPERS.has(held.type)) held = held.namedChildren[0] ?? null;
    if (held?.type !== "call_expression") return null;
    const callee = held.childForFieldName("function");
    if ((callee?.type !== "identifier" && callee?.type !== "member_expression") || !NAMED_VALUE.test(callee.text)) return null;
    calls.push(held);
  }
  return calls.length > 0 ? { holder: name.text, calls, keys } : null;
}

/**
 * The key a record entry is held under, as `LocalType.key` spells it: a quoted literal (`club: …`, `'club': …` →
 * `'club'`) or the module-level name a computed key reads (`[Kind.Club]: …` → `Kind.Club`). Null for any other key.
 */
function entryKey(key: Node | null): string | null {
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return `'${key.text}'`;
  if (key.type === "string") return key.text.length > 2 ? `'${key.text.slice(1, -1)}'` : null;
  if (key.type === "computed_property_name") {
    const inner = key.namedChildren[0];
    if (inner?.type === "string") return inner.text.length > 2 ? `'${inner.text.slice(1, -1)}'` : null;
    return inner && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(inner.text) ? inner.text : null;
  }
  return null;
}

/**
 * Where the key of a read off a record of call results comes from (`stores[props.kind].actions` → the prop `kind`):
 * `LocalType.indexOrigin` / `CallInfo.indexOrigin`. Only a prop, plain: the origin a component's users can name.
 */
export function recordIndexOrigin(node: Node): CallArgOrigin["origin"] | null {
  let cur: Node | null = node;
  while (cur?.type === "member_expression") cur = cur.childForFieldName("object");
  if (cur?.type !== "subscript_expression") return null;
  const holder = cur.childForFieldName("object");
  if (holder?.type !== "identifier" || !recordHolders(cur).has(holder.text)) return null;
  const index = cur.childForFieldName("index");
  const found = index ? expressionOrigin(index) : null;
  return found && !found.transform && !found.derivation && found.origin.kind === "prop" ? found.origin : null;
}

let recordsTree: Node["tree"] | null = null;
let recordNames = new Set<string>();

/** The names the file binds to records of call results, in any scope (read once per tree). */
export function recordHolders(node: Node): ReadonlySet<string> {
  if (node.tree === recordsTree) return recordNames;
  recordsTree = node.tree;
  recordNames = new Set();
  for (const d of node.tree.rootNode.descendantsOfType("variable_declarator")) {
    const record = d ? recordEntries(d) : null;
    if (record) recordNames.add(record.holder);
  }
  return recordNames;
}

/**
 * A member read off a record of call results at a key known only at run time, spelled as the linker reads it:
 * `stores[props.kind].actions` → `stores[].actions`, `stores[kind].createOne` → `stores[].createOne`. Null for
 * any other chain — a lookup with a fixed key, an optional step, a call in the chain.
 */
export function recordMemberChain(node: Node): string | null {
  const members: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === "member_expression") {
    const property = cur.childForFieldName("property");
    if (property?.type !== "property_identifier" || cur.children.some((c) => c.type === "?.")) return null;
    members.unshift(property.text);
    cur = cur.childForFieldName("object");
  }
  if (cur?.type !== "subscript_expression" || cur.children.some((c) => c.type === "?.")) return null;
  const object = cur.childForFieldName("object");
  if (object?.type !== "identifier" || !runtimeIndex(cur.childForFieldName("index")) || !recordHolders(cur).has(object.text)) return null;
  return [`${object.text}[]`, ...members].join(".");
}

/** The callee of a call on a record of call results (`stores[props.kind].actions.createOne`) as `stores[].actions.createOne`. */
export function recordCallee(callee: Node): string | null {
  return callee.type === "member_expression" ? recordMemberChain(callee) : null;
}
