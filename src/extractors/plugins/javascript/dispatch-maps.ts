/**
 * A module-level map's values are `<setup>`'s; the linker joins `ACTIONS.save()` to that key's function and
 * `ACTIONS[kind]()` (the call name `ACTIONS[]`) to each of the map's, INFERRED (`dispatch:object-map`). A map
 * imported from a project module (relative or `@/`, `~`, `#`) and handed down (`:actions="clubActions"`,
 * `actions={clubActions}`) is a `functionProps` entry carrying `mapImport` (`:actions="ACTIONS"`, `actions={ACTIONS}`
 * give one per held function, `actions.save`; the handler imported when the file imports it:
 * `FunctionPropBinding.handlerImport`, resolved by the prop-callback resolver; a function the callback hands on
 * counts as its writer's calls in the duplicate detector, `withHeldCalls`). The prop-callback resolver expands it
 * from the declaring module's `<setup>` (named re-exports and each `export *` followed, four hops), one function prop
 * per key, the binding site staying the handing page (dispatch-map-props.ts, dispatch.ts).
 *
 * A prop binding whose value cannot be read is listed in `FileAnalysis.unreadPropBindings` (`:kind="row.kind"`,
 * `kind={pick(x)}`, a JSX string literal, which `propBindings` keeps none of) and keeps the full fan-out.
 * `dispatch(props.fetchKey)` links only the names read; an unread user's action stays unlinked.
 */

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
  const map = readMap(declarator);
  return map && map.entries.length > 0 ? { holder: map.holder, entries: map.entries } : null;
}

/** `dispatchMapEntries` plus the keys held by a function written in place, and also for a map holding only such functions. */
function readMap(declarator: Node): { holder: string; entries: DispatchMapEntry[]; inline: string[] } | null {
  if (declarator.type !== "variable_declarator") return null;
  const decl = declarator.parent;
  if (decl?.type !== "lexical_declaration" || decl.child(0)?.type !== "const") return null;
  const name = declarator.childForFieldName("name");
  let value = declarator.childForFieldName("value");
  while (value && TYPE_WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
  if (name?.type !== "identifier" || value?.type !== "object") return null;
  const entries: DispatchMapEntry[] = [];
  const inline: string[] = [];
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
    if (INLINE_FUNCTIONS.has(held.type)) {
      if (key.type === "property_identifier" || key.type === "string") inline.push(key.type === "string" ? key.text.slice(1, -1) : key.text);
      continue;
    }
    if ((held.type !== "identifier" && held.type !== "member_expression") || !NAMED_VALUE.test(held.text)) return null;
    const keyText = key.type === "string" ? key.text.slice(1, -1) : key.text;
    entries.push({ value: held, key: keyText });
  }
  return entries.length > 0 || inline.length > 0 ? { holder: name.text, entries, inline } : null;
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
 * the key is the map's, however much its leaf looks like a promise or array method. `withInline` counts a key held by a
 * function written in place (`{ send: () => post() }`), which is a function of its own that the call reaches by name.
 */
export function dispatchMapMember(callName: string, node: Node, withInline = false): boolean {
  const dot = callName.indexOf(".");
  if (dot <= 0 || callName.indexOf(".", dot + 1) >= 0) return false;
  const keys = mapKeysOf(node.tree).get(callName.slice(0, dot));
  const key = callName.slice(dot + 1);
  return !!keys && (keys.entries.has(key) || (withInline && keys.inline.has(key)));
}

let keysTree: Node["tree"] | null = null;
let keysMemo = new Map<string, { entries: Set<string>; inline: Set<string> }>();

/** The keys of every dispatch map a file declares, by holder (read once per tree). */
function mapKeysOf(tree: Node["tree"]): ReadonlyMap<string, { entries: Set<string>; inline: Set<string> }> {
  if (tree === keysTree) return keysMemo;
  keysTree = tree;
  keysMemo = new Map();
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const map = d ? readMap(d) : null;
    if (!map) continue;
    const held = keysMemo.get(map.holder) ?? keysMemo.set(map.holder, { entries: new Set(), inline: new Set() }).get(map.holder)!;
    for (const e of map.entries) held.entries.add(e.key);
    for (const k of map.inline) held.inline.add(k);
  }
  return keysMemo;
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

/**
 * A store picked by an immediately invoked function around a `switch` on a prop:
 *
 *     const store = (() => { switch (props.kind) { case "club": return useClubStore(); case "player": return usePlayerStore(); default: throw … } })();
 *
 * Stated as the record `{ club: useClubStore(), player: usePlayerStore() }` read at the key `props.kind`: one
 * entry per case literal (grouped cases share their return), `key` null for a `default` that returns a call
 * (an unreadable key, so the read reaches every entry). Null for any other shape — a case that returns anything
 * but a named call, a statement besides the `switch`, a discriminant that is no plain prop, a case that is
 * no literal, a `const` that is no IIFE.
 *
 * A store picked by an IIFE `switch`
 * (`const store = (() => { switch (props.kind) { case "club": return useClubStore(); … } })()`) is stated as the
 * record `store[]`: one `localTypes` entry per case literal with its `key` (grouped cases share their return; a
 * `default` that returns a call has no key, so `recordChoice` cannot narrow and the read reaches every entry; a
 * `default` that only throws holds none), and a local `store` whose `from` is `store[]` with `indexOrigin` the
 * switch's discriminant when it is a plain prop; core's `recordCall` then narrows exactly as for a record read at a
 * run-time key. The same `switch` in a named helper of the file (`function pickStore(kind) { switch (kind) { … } }`
 * or `const pickStore = (kind) => …`, one plain parameter, nothing else in its body: `localFunction`, `soleSwitch`,
 * `switchArms`) states the same record for `const store = pickStore(props.kind)`. (Written with single quotes:
 * `(() => { switch (props.kind) { case 'club': return useClubStore() … } })()`.) Any other shape (a case returning a
 * non-call, extra statements, a computed or non-literal case, a discriminant that is no plain prop, an IIFE with
 * parameters, a helper another file declares or one handed anything but a plain prop) states nothing.
 *
 * A record of call results indexed by a prop (`stores[props.kind]`, `LocalType.key` per entry,
 * `CallInfo.indexOrigin`/`LocalType.indexOrigin` for the index) is narrowed by `recordChoice` (record-choice.ts) to
 * the entries the component's users bind the prop to — a literal (`kind="player"`), an imported enum member or
 * constant (`PropBinding` origin `constant`, `:kind="Kind.Club"`; only a dotted name or an UPPER_SNAKE one), or a
 * prop they hand on — each link kept to its binding sites (`viaUsage`). No binding naming an entry, an unreadable
 * entry key, or a bound value of another origin (a route parameter; `PropLiterals.complete` false, so `recordChoice`
 * returns null) keeps the full fan-out, never narrower than what one user could pick. A dispatch map imported and
 * handed down as a prop is `FunctionPropBinding.mapImport`, expanded from the declaring module.
 */
export function switchRecordEntries(declarator: Node): { holder: string; calls: Node[]; keys: Array<string | null>; indexOrigin: CallArgOrigin["origin"] } | null {
  if (declarator.type !== "variable_declarator") return null;
  const decl = declarator.parent;
  if (decl?.type !== "lexical_declaration" || decl.child(0)?.type !== "const") return null;
  const name = declarator.childForFieldName("name");
  const value = declarator.childForFieldName("value");
  if (name?.type !== "identifier" || value?.type !== "call_expression") return null;
  const args = value.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
  let fn = value.childForFieldName("function");
  while (fn?.type === "parenthesized_expression") fn = fn.namedChildren[0] ?? null;
  let sw: Node | null;
  let origin: CallArgOrigin["origin"] | null;
  if (fn?.type === "arrow_function" || fn?.type === "function_expression") {
    if (args.length !== 0 || (fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter"))?.namedChildCount) return null;
    sw = soleSwitch(fn);
    origin = sw ? propOrigin(sw.childForFieldName("value")) : null;
  } else if (fn?.type === "identifier" && args.length === 1) {
    // A named helper of the file, handed the prop: `pickStore(props.kind)` with `function pickStore(kind) { switch (kind) … }`.
    const helper = localFunction(value.tree.rootNode, fn.text);
    const params = helper ? (helper.childForFieldName("parameters") ?? helper.childForFieldName("parameter")) : null;
    const formal = params?.type === "identifier" ? params : params?.namedChildCount === 1 ? params.namedChildren[0] : null;
    const formalName = formal?.type === "identifier" ? formal.text : formal?.type === "required_parameter" && formal.childForFieldName("pattern")?.type === "identifier" ? formal.childForFieldName("pattern")!.text : null;
    sw = helper && formalName ? soleSwitch(helper) : null;
    let subject = sw?.childForFieldName("value") ?? null;
    while (subject?.type === "parenthesized_expression") subject = subject.namedChildren[0] ?? null;
    origin = subject?.type === "identifier" && subject.text === formalName ? propOrigin(args[0]!) : null;
  } else return null;
  if (!sw || !origin) return null;
  const arms = switchArms(sw);
  return arms ? { holder: name.text, ...arms, indexOrigin: origin } : null;
}

/** A plain prop the way a component's users can name it (`props.kind`), else null. */
function propOrigin(node: Node | null): CallArgOrigin["origin"] | null {
  let subject = node;
  while (subject?.type === "parenthesized_expression") subject = subject.namedChildren[0] ?? null;
  const found = subject ? expressionOrigin(subject) : null;
  return found && !found.transform && !found.derivation && found.origin.kind === "prop" ? found.origin : null;
}

/** The one `switch` a function's block body consists of, else null. */
function soleSwitch(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  if (body?.type !== "statement_block") return null;
  const statements = body.namedChildren.filter((c) => c.type !== "comment");
  return statements.length === 1 && statements[0]!.type === "switch_statement" ? statements[0]! : null;
}

/** A function the file declares at its top level by name: `function f(…) {…}`, `const f = (…) => {…}`. */
function localFunction(root: Node, name: string): Node | null {
  for (const st of root.namedChildren) {
    const inner = st.type === "export_statement" ? st.namedChildren.find((c) => c.type === "function_declaration" || c.type === "lexical_declaration") ?? st : st;
    if (inner.type === "function_declaration" && inner.childForFieldName("name")?.text === name) return inner;
    if (inner.type !== "lexical_declaration") continue;
    for (const d of inner.namedChildren) {
      const v = d.type === "variable_declarator" && d.childForFieldName("name")?.text === name ? d.childForFieldName("value") : null;
      if (v?.type === "arrow_function" || v?.type === "function_expression") return v;
    }
  }
  return null;
}

/** The entries of a `switch` whose every arm returns a named call (or throws): one per case literal, `key` null for a `default` that returns one. */
function switchArms(sw: Node): { calls: Node[]; keys: Array<string | null> } | null {
  const calls: Node[] = [];
  const keys: Array<string | null> = [];
  let pending: Array<string | null> = [];
  for (const arm of sw.childForFieldName("body")?.namedChildren ?? []) {
    if (arm.type === "comment") continue;
    if (arm.type !== "switch_case" && arm.type !== "switch_default") return null;
    if (arm.type === "switch_case") {
      const label = arm.childForFieldName("value");
      const key = label?.type === "string" && label.text.length > 2 ? `'${label.text.slice(1, -1)}'` : null;
      if (!key) return null;
      pending.push(key);
    } else pending.push(null);
    const stmts = arm.namedChildren.filter((c) => c.type !== "comment" && c.id !== arm.childForFieldName("value")?.id);
    if (stmts.length === 0) continue;
    let only: Node | null = stmts.length === 1 ? stmts[0]! : null;
    if (only?.type === "statement_block") {
      const inner = only.namedChildren.filter((c) => c.type !== "comment");
      only = inner.length === 1 ? inner[0]! : null;
    }
    if (!only) return null;
    // A `default` that only throws holds no entry.
    if (only.type === "throw_statement") {
      pending = [];
      continue;
    }
    if (only.type !== "return_statement") return null;
    let held: Node | null = only.namedChildren.find((c) => c.type !== "comment") ?? null;
    while (held && TYPE_WRAPPERS.has(held.type)) held = held.namedChildren[0] ?? null;
    if (held?.type !== "call_expression") return null;
    const callee = held.childForFieldName("function");
    if ((callee?.type !== "identifier" && callee?.type !== "member_expression") || !NAMED_VALUE.test(callee.text)) return null;
    for (const key of pending) {
      calls.push(held);
      keys.push(key);
    }
    pending = [];
  }
  if (pending.length > 0) return null;
  return calls.length > 0 ? { calls, keys } : null;
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
