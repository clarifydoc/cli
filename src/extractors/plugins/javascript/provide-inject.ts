import type { Node, Tree } from "web-tree-sitter";
import { literalString } from "../../shared/node-helpers.js";
import type { ContextValue } from "../../../types/analysis.js";

/**
 * Values a Vue component hands its descendants by key, and what a descendant
 * takes under that key: `provide('transferPlayer', onTransferPlayer)` in an
 * ancestor, `const transferPlayer = inject('transferPlayer')` … `transferPlayer(p)`
 * below it. The call has no name-resolvable edge — Vue looks the key up the
 * component tree at runtime — so the provide/inject resolver joins the two by
 * key. Only a literal key, and only a provided value that names a function
 * (`onTransferPlayer`, `this.onTransferPlayer`): an inline arrow names nothing
 * to link to.
 */
export function contextValues(tree: Tree, sourceText: string): ContextValue[] {
  if (!/\b(?:provide|inject)\s*\(/.test(sourceText)) return [];
  const out: ContextValue[] = [];
  // `const { signPlayer, release: releasePlayer } = useSquadActions()`: local → factory + key.
  const destructured = new Map<string, { from: string; member: string }>();
  const visit = (n: Node): void => {
    if (n.type === "call_expression") {
      const found = contextValueOf(n);
      if (found) out.push(found);
      const typed = typedContextValue(n);
      if (typed) out.push(typed);
    } else if (n.type === "variable_declarator") {
      readDestructuring(n, destructured);
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  for (const v of out) {
    const d = v.kind === "provide" ? destructured.get(v.name) : undefined;
    if (d) Object.assign(v, d);
  }
  return out;
}

/** The locals an object pattern takes from a factory's result, with the key each is read under. */
function readDestructuring(decl: Node, into: Map<string, { from: string; member: string }>): void {
  const pattern = decl.childForFieldName("name");
  let value = decl.childForFieldName("value");
  if (value?.type === "await_expression") value = value.namedChild(0);
  const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
  if (pattern?.type !== "object_pattern" || callee?.type !== "identifier") return;
  for (const p of pattern.namedChildren) {
    if (p?.type === "shorthand_property_identifier_pattern") into.set(p.text, { from: callee.text, member: p.text });
    else if (p?.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier") {
      into.set(p.childForFieldName("value")!.text, { from: callee.text, member: p.childForFieldName("key")!.text });
    }
  }
}

function contextValueOf(call: Node): ContextValue | null {
  const callee = call.childForFieldName("function")?.text;
  if (callee !== "provide" && callee !== "inject") return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  const key = literalKey(args[0]);
  if (!key) return null;
  const line = call.startPosition.row + 1;
  if (callee === "provide") {
    if (args.length !== 2) return null;
    const value = args[1]!;
    const name =
      value.type === "identifier" ? value.text
      : value.type === "member_expression" && value.childForFieldName("object")?.type === "this" ? value.childForFieldName("property")?.text
      : undefined;
    return name ? { kind: "provide", key, name, line } : null;
  }
  // `const transferPlayer = inject('transferPlayer')`: the local the component calls.
  const holder = call.parent;
  if (holder?.type !== "variable_declarator" || holder.childForFieldName("value")?.id !== call.id) return null;
  const local = holder.childForFieldName("name");
  return local?.type === "identifier" ? { kind: "inject", key, name: local.text, line } : null;
}

/**
 * The value a key hands on, by type: `provide(LeagueKey, useLeague())` — the factory called —, `provide(LeagueKey, league)` — a
 * local the file types — and `const league = inject(LeagueKey)`. The key is a literal or an identifier (an imported symbol,
 * `keyRef`); the project pass resolves an identifier to the declaration it names, so two modules' `Key` stay two keys.
 */
const WRAPPERS: ReadonlySet<string> = new Set(["non_null_expression", "as_expression", "satisfies_expression", "parenthesized_expression"]);
/** Where Vue's `provide`/`inject` come from; a project helper of the same name is none of them. */
const VUE_SOURCE = /^(?:vue|@vue\/[\w-]+|@vueuse\/[\w-]+|#imports|nuxt\/app|#app)$/;

function typedContextValue(call: Node): ContextValue | null {
  const callee = call.childForFieldName("function")?.text;
  if (callee !== "provide" && callee !== "inject") return null;
  if (importedFromElsewhere(call.tree.rootNode, callee)) return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  const literal = literalKey(args[0]);
  const ref = !literal && args[0]?.type === "identifier" ? args[0].text : null;
  const key = literal || ref;
  if (!key) return null;
  const line = call.startPosition.row + 1;
  const keyed = ref ? { keyRef: true as const } : {};
  if (callee === "provide") {
    const value = args[1];
    if (args.length !== 2 || !value) return null;
    if (value.type === "identifier") return { kind: "provide-typed", key, ...keyed, name: value.text, line };
    const fn = value.type === "call_expression" ? value.childForFieldName("function") : null;
    return fn?.type === "identifier" ? { kind: "provide-typed", key, ...keyed, name: fn.text, factory: true, line } : null;
  }
  // `inject(Key)!`, `inject(Key) as League`: the declarator holds the wrapper.
  let held: Node = call;
  while (held.parent && WRAPPERS.has(held.parent.type)) held = held.parent;
  const holder = held.parent;
  if (holder?.type !== "variable_declarator" || holder.childForFieldName("value")?.id !== held.id) return null;
  const local = holder.childForFieldName("name");
  return local?.type === "identifier" ? { kind: "inject-typed", key, ...keyed, name: local.text, line } : null;
}

/** Whether the file imports `name` from a module that is not Vue's. */
function importedFromElsewhere(root: Node, name: string): boolean {
  for (const stmt of root.namedChildren) {
    if (stmt?.type !== "import_statement") continue;
    const source = stmt.childForFieldName("source")?.text.slice(1, -1) ?? "";
    if (!VUE_SOURCE.test(source) && stmt.descendantsOfType("identifier").some((id) => id?.text === name)) return true;
  }
  return false;
}

/** `'transferPlayer'`, `"transferPlayer"`, `` `transferPlayer` `` (no substitution). */
function literalKey(arg: Node | undefined): string | null {
  return literalString(arg) || null;
}
