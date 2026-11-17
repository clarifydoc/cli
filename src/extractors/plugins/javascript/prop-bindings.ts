import type { Node, Tree } from "web-tree-sitter";
import type { FunctionPropBinding, InteractiveElementInfo, PropBinding } from "../../../types/analysis.js";
import { expressionOrigin, templateValueOrigin } from "./arg-origins.js";
import { derivedMemberKeys, derivedObjectAt, importedBinding, libraryObjectAt } from "./library-callbacks.js";
import { dispatchMapAt, PROJECT_SOURCE } from "./dispatch-map-props.js";
import { heldFunction } from "./held-functions.js";
import { namesFunction } from "./member-values.js";
import { inlineCallbacksOf, literalCallbacksOf } from "./interactive-elements.js";

/**
 * Values a component's markup binds to its children's props, where the value's
 * origin is known (`FileAnalysis.propBindings`): JSX `<ClubCard clubId={id} />`
 * and a Vue template's `<ClubCard :club-id="clubId" />`. The `paramOrigins`
 * pass follows a child's `props.clubId` up through them to a route parameter.
 */
export function propBindings(tree: Tree, sourceText: string, rawSource: string, filePath: string): PropBinding[] {
  const unread: Unread[] = [];
  unreadOf.set(tree, unread);
  if (filePath.endsWith(".vue")) return vueBindings(tree, rawSource, unread);
  if (!/<[A-Z][\w.]*[\s/>]/.test(sourceText)) return [];
  const out: PropBinding[] = [];
  const visit = (n: Node): void => {
    if (n.type === "jsx_opening_element" || n.type === "jsx_self_closing_element") {
      const tag = n.childForFieldName("name")?.text ?? "";
      if (/^[A-Z]/.test(tag)) {
        for (const attr of n.namedChildren) {
          if (attr?.type !== "jsx_attribute") continue;
          const name = attr.namedChild(0);
          const value = attr.namedChild(1);
          if (name?.type !== "property_identifier") continue;
          // What React itself takes (`key`, `ref`, `className`, `children`) is no prop to choose by.
          const reserved = JSX_RESERVED.has(name.text);
          // `kind="club"`: a literal is no binding of ours (`propBindings` keeps none in JSX), but a name a choice by the bound values would miss.
          if (value?.type === "string") {
            if (!reserved && NAME_LITERAL.test(value.text.slice(1, -1))) unread.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1 });
            continue;
          }
          if (value?.type !== "jsx_expression") continue;
          const expr = value.namedChild(0);
          const found = expr ? expressionOrigin(expr) : null;
          // A value no origin is read for, never a function written in place: a pass choosing by the bound values must not rule it out.
          const noteUnread = () => {
            if (expr && !reserved && !NOT_A_NAME.has(expr.type)) unread.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1 });
          };
          // `kind={Kind.Club}`: a constant another module declares.
          if (!found && expr && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(expr.text) && importsName(tree, expr.text)) {
            out.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1, origin: { kind: "constant", ref: expr.text } });
            continue;
          }
          if (!found) {
            noteUnread();
            continue;
          }
          if (found.origin.kind === "literal") {
            if (!reserved && NAME_LITERAL.test(found.origin.value)) unread.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1 });
            continue;
          }
          out.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1, origin: found.origin, ...(found.transform ? { transform: found.transform } : {}), ...(found.derivation ? { derivation: found.derivation } : {}) });
        }
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

/** Expressions that are no name a choice could be made by: a function written in place, a number, a boolean, null. */
const NOT_A_NAME: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "number", "true", "false", "null"]);

const JSX_RESERVED: ReadonlySet<string> = new Set(["key", "ref", "className", "children"]);

type Unread = { component: string; prop: string; line: number };
/** The unread bindings of the tree `propBindings` last read, for `unreadPropBindings`. */
const unreadOf = new WeakMap<Tree, Unread[]>();

/** The prop bindings of the file `propBindings` just read whose value could not be read, once per component and prop. */
export function unreadPropBindings(tree: Tree): Unread[] {
  const first = new Map<string, Unread>();
  for (const u of unreadOf.get(tree) ?? []) if (!first.has(`${u.component}\0${u.prop}`)) first.set(`${u.component}\0${u.prop}`, u);
  return [...first.values()];
}

/**
 * One of the file's own functions a JSX tag hands a child under a prop no event name marks (`<KitRow order={orderKit} />`,
 * `<SquadDialog handleRelease={this.releasePlayer} />`): the child runs it when it calls the prop. An `on…` prop is an
 * interactive element already; a value that is no function the file declares (a state variable, a constant) is data.
 */
export function jsxFunctionProps(tree: Tree, sourceText: string, declared: ReadonlySet<string>): FunctionPropBinding[] {
  if (!/<[A-Z][\w.]*[\s/>]/.test(sourceText)) return [];
  const out: FunctionPropBinding[] = [];
  for (const n of tree.rootNode.descendantsOfType(["jsx_opening_element", "jsx_self_closing_element"])) {
    const tag = n?.childForFieldName("name")?.text ?? "";
    if (!n || !/^[A-Z][\w$]*$/.test(tag)) continue;
    for (const attr of n.namedChildren) {
      if (attr?.type !== "jsx_attribute") continue;
      const name = attr.namedChild(0);
      const value = attr.namedChild(1);
      if (name?.type !== "property_identifier" || /^on[A-Z]/.test(name.text) || value?.type !== "jsx_expression") continue;
      const expr = value.namedChild(0);
      // `<Pager table={table} />` with `const table = useReactTable({ onPaginationChange })`: the child's `table.nextPage()` runs it.
      const library = expr?.type === "identifier" ? libraryObjectAt(attr, expr.text, heldFunction, namesFunction) : null;
      for (const m of library ?? []) out.push({ component: tag, prop: `${name.text}.${m.method}`, handler: m.name, line: attr.startPosition.row + 1 });
      if (library) continue;
      // `<HeaderCell header={header} />` inside `table.getHeaderGroups().map(…)`: the child's `header.column.toggleSorting()` runs the table's `onSortingChange`.
      const derived = expr?.type === "identifier" && ITERATION.test(sourceText) ? derivedObjectAt(attr, expr.text, heldFunction, namesFunction) : null;
      for (const m of derived ?? []) {
        for (const key of derivedMemberKeys(name.text, m.method)) out.push({ component: tag, prop: key, handler: m.name, line: attr.startPosition.row + 1 });
      }
      if (derived) continue;
      // `<ClubTable actions={ACTIONS} />` with `const ACTIONS = { save: saveClub }`: the child's `actions.save()` runs it.
      const held = expr?.type === "identifier" ? dispatchMapAt(attr, expr.text, namesFunction) : null;
      for (const h of held ?? []) {
        out.push({ component: tag, prop: `${name.text}.${h.key}`, handler: h.name, line: attr.startPosition.row + 1, ...(h.handlerImport ? { handlerImport: h.handlerImport } : {}) });
      }
      if (held) continue;
      // `<ClubTable actions={clubActions} />` with `clubActions` imported: a dispatch map there, which the resolver reads.
      const imported = expr?.type === "identifier" && !declared.has(expr.text) ? importedBinding(expr.tree, expr.text) : null;
      if (imported && imported.imported !== "default" && PROJECT_SOURCE.test(imported.source)) out.push({ component: tag, prop: name.text, handler: expr!.text, line: attr.startPosition.row + 1, mapImport: { source: imported.source, name: imported.imported } });
      // `order={orderKit}`, `order={this.orderKit}`, or an arrow passing it on: `order={(size) => orderKit(size)}`.
      const handler = expr ? handedFunction(expr.type === "arrow_function" || expr.type === "function_expression" ? firstCallee(expr) : expr) : null;
      if (handler && declared.has(handler.replace(/^this\./, ""))) out.push({ component: tag, prop: name.text, handler, line: attr.startPosition.row + 1 });
      // `handleClose={() => setOpen(false)}`: an arrow that hands on no declared function is a function of its own (`heldFunction`).
      else if (expr && (expr.type === "arrow_function" || expr.type === "function_expression")) {
        const own = heldFunction(expr);
        if (own) out.push({ component: tag, prop: name.text, handler: own, line: attr.startPosition.row + 1 });
      }
    }
  }
  return out;
}

/** Whether a file iterates anything (a derived local is an iteration's parameter). */
const ITERATION = /\.(?:map|forEach|flatMap|filter|find|some|every)\(/;

/** A function named by an identifier or `this.member`, as written. */
function handedFunction(n: Node | null): string | null {
  if (n?.type === "identifier") return n.text;
  return n?.type === "member_expression" && /^this\.[A-Za-z_$][\w$]*$/.test(n.text) ? n.text : null;
}

/** The callee of the first call an arrow's body makes (`(size) => orderKit(size)`, `() => { void this.orderKit(); }`). */
function firstCallee(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  const call = body?.type === "call_expression" ? body : body?.descendantsOfType("call_expression")[0] ?? null;
  return call?.childForFieldName("function") ?? null;
}

/**
 * A name a component takes as a string and acts on by name — a store action (`squad/fetchPlayers`), a store or
 * kind to pick (`player`) —, never prose, a CSS value or a number: what a literal binding is kept for.
 */
const NAME_LITERAL = /^(?!(?:true|false|null|undefined)$)[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)*$/;
/** An arrow or function expression written in markup: a function handed down, no value to choose by. */
const INLINE_FN = /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|^(?:async\s+)?function\b/;
/** Attributes every tag takes, never a prop the component declares. */
const NOT_PROPS: ReadonlySet<string> = new Set(["key", "ref", "class", "style", "is", "id", "slot"]);

/**
 * `:club-id="clubId"` / `v-bind:club-id="…"` on a component tag (PascalCase or kebab-case with a hyphen), and a
 * name handed as a literal — `fetch-key="squad/fetchPlayers"`, `:action-name="'clubs/update'"` (`NAME_LITERAL`).
 */
function vueBindings(tree: Tree, raw: string, unread: Unread[]): PropBinding[] {
  const start = raw.search(/<template\b/i);
  const end = raw.lastIndexOf("</template>");
  if (start < 0 || end < start) return [];
  const anchor = tree.rootNode.namedChildren.find((c) => !!c && c.type !== "comment") ?? null;
  let declared: Set<string> | null = null;
  const out: PropBinding[] = [];
  const template = raw.slice(start, end);
  const lineAt = (offset: number) => raw.slice(0, start + offset).split("\n").length;
  const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  for (const tag of template.matchAll(/<([A-Z][\w]*|[a-z][\w]*-[\w-]*)(?=[\s/>])/g)) {
    const attrs = attributesAfter(template, tag.index! + tag[0].length);
    for (const a of attrs) {
      const bound = /^(?::|v-bind:)([\w-]+)$/.exec(a.name);
      if (!bound) {
        // `fetch-key="squad/fetchPlayers"`: a literal the component takes by name.
        if (/^[a-z][\w-]*$/.test(a.name) && !/^(?:v-|data-|aria-)/.test(a.name) && !NOT_PROPS.has(a.name) && NAME_LITERAL.test(a.value)) {
          out.push({ component: tag[1]!, prop: camel(a.name), line: lineAt(a.offset), origin: { kind: "literal", value: a.value } });
        }
        continue;
      }
      const prop = camel(bound[1]!);
      if (NOT_PROPS.has(prop)) continue;
      const value = a.value.trim();
      // `:action-name="'clubs/update'"`
      const quoted = /^(['"`])(.*)\1$/.exec(value);
      if (quoted) {
        if (NAME_LITERAL.test(quoted[2]!)) out.push({ component: tag[1]!, prop, line: lineAt(a.offset), origin: { kind: "literal", value: quoted[2]! } });
        continue;
      }
      // A value no origin is read for: a pass choosing by the bound values must not rule it out.
      const noteUnread = () => {
        if (!INLINE_FN.test(value) && !/^(?:-?\d[\d.]*|true|false|null|undefined)$/.test(value)) unread.push({ component: tag[1]!, prop, line: lineAt(a.offset) });
      };
      if (!anchor) {
        noteUnread();
        continue;
      }
      declared ??= declaredProps(tree.rootNode);
      const wrapped = /^(Number|String|parseInt|encodeURIComponent)\(\s*(.*?)\s*\)$/.exec(value);
      const chain = wrapped ? wrapped[2]! : value;
      if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(chain)) {
        noteUnread();
        continue;
      }
      const found = templateValueOrigin(anchor, chain.split("."), declared);
      // `:kind="Kind.Club"`: a constant (an enum member) the script imports.
      if (!found && !wrapped && importsName(tree, chain)) {
        out.push({ component: tag[1]!, prop, line: lineAt(a.offset), origin: { kind: "constant", ref: chain } });
        continue;
      }
      if (!found) {
        noteUnread();
        continue;
      }
      if (found.origin.kind === "literal") {
        if (NAME_LITERAL.test(found.origin.value)) noteUnread();
        continue;
      }
      out.push({ component: tag[1]!, prop, line: lineAt(a.offset), origin: found.origin, ...(wrapped ? { transform: wrapped[1]! } : {}), ...(found.derivation ? { derivation: found.derivation } : {}) });
    }
  }
  return out;
}

/** Whether the file imports the name a member chain starts with (`Kind` of `Kind.Club`). */
function importsName(tree: Tree, chain: string): boolean {
  // A member of an enum or a map (`Kind.Club`) or an UPPER_SNAKE constant: not a component or a function handed on.
  if (!chain.includes(".") && !/^[A-Z][A-Z0-9_]*$/.test(chain)) return false;
  const head = chain.split(".")[0]!;
  return tree.rootNode.namedChildren.some((n) => n?.type === "import_statement" && !/^import\s+type\b/.test(n.text) && n.descendantsOfType("identifier").some((id) => id?.text === head));
}

/** The attributes of a tag from `from` to its `>`, quoted values kept whole. */
export function attributesAfter(text: string, from: number): Array<{ name: string; value: string; offset: number }> {
  const out: Array<{ name: string; value: string; offset: number }> = [];
  const re = /\s*([^\s=/>"']+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?|\s*\/?>/gy;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[1]) break;
    if (m[2] !== undefined) out.push({ name: m[1], value: m[3] ?? m[4] ?? "", offset: m.index });
  }
  return out;
}

/** The props a Vue component declares: `defineProps<{ a: T }>()` (or a named type), `defineProps({ a: … })`, `['a']`, an options `props:`. */
function declaredProps(root: Node): Set<string> {
  const out = new Set<string>();
  const typeMembers = (t: Node | null): void => {
    if (!t) return;
    if (t.type === "object_type" || t.type === "interface_body") {
      for (const m of t.namedChildren) if (m?.type === "property_signature") out.add(m.childForFieldName("name")?.text ?? "");
      return;
    }
    if (t.type === "type_identifier") {
      for (const d of root.descendantsOfType(["interface_declaration", "type_alias_declaration"])) {
        if (d?.childForFieldName("name")?.text !== t.text) continue;
        typeMembers(d.type === "interface_declaration" ? d.childForFieldName("body") : d.childForFieldName("value"));
      }
    }
  };
  const valueMembers = (v: Node | null | undefined): void => {
    if (v?.type === "object") {
      for (const p of v.namedChildren) {
        if (p?.type === "pair") out.add(p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "") ?? "");
        else if (p?.type === "shorthand_property_identifier") out.add(p.text);
      }
    } else if (v?.type === "array") {
      for (const e of v.namedChildren) if (e?.type === "string") out.add(e.text.slice(1, -1));
    }
  };
  for (const call of root.descendantsOfType("call_expression")) {
    if (call?.childForFieldName("function")?.text !== "defineProps") continue;
    const typeArg = call.childForFieldName("type_arguments")?.namedChild(0) ?? null;
    typeMembers(typeArg);
    valueMembers(call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment"));
  }
  for (const pair of root.descendantsOfType("pair")) {
    if (pair?.childForFieldName("key")?.text !== "props" || pair.parent?.parent?.type === "pair") continue;
    valueMembers(pair.childForFieldName("value"));
  }
  out.delete("");
  return out;
}

/**
 * `<Toolbar :extra="[{ label: 'Archive', run: archive }]" />` (or a literal array the script declares, `:extra="actions"`):
 * the functions the array's objects hold under each key, handed to the child as `extra.run`, so the child's loop over its
 * prop (`v-for="x in extra"` ... `x.run()`, `ScopeEntry.fromProp`) runs them. `handsOn` accepts the file's own functions.
 */
export function vueArrayFunctionProps(template: string, raw: string, script: string, handsOn: (name: string) => boolean, heldNames: readonly string[] = []): FunctionPropBinding[] {
  if (!/(?:^|\s)(?::|v-bind:)[\w-]+="/.test(template)) return [];
  const out: FunctionPropBinding[] = [];
  const start = raw.indexOf(template);
  for (const tag of template.matchAll(/<([A-Z][\w]*|[a-z][\w]*-[\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g)) {
    for (const bind of (tag[2] ?? "").matchAll(/(?:^|\s)(?::|v-bind:)([a-zA-Z][\w-]*)="([^"]*)"/g)) {
      const value = bind[2]!.trim();
      const found = value.startsWith("[") ? inlineCallbacksOf(value) : /^[A-Za-z_$][\w$]*$/.test(value) ? literalCallbacksOf(value, script) : undefined;
      if (!found) continue;
      const prop = bind[1]!.replace(/-([a-z\d])/g, (_m, c: string) => c.toUpperCase());
      const line = raw.slice(0, start + tag.index!).split("\n").length;
      for (const [key, names] of Object.entries(found)) {
        for (const handler of names) {
          // A callback written in place in a declared array is named up to its line (`<rows[].run@`): each of them, by its held name.
          if (handler.endsWith("@")) for (const held of heldNames) if (held.startsWith(handler)) out.push({ component: tag[1]!, prop: `${prop}.${key}`, handler: held, line });
          if (!handler.endsWith("@") && handsOn(handler)) out.push({ component: tag[1]!, prop: `${prop}.${key}`, handler, line });
        }
      }
    }
  }
  return out;
}

/** Drops the `fromProp` mark from a loop whose collection is no prop the component declares. */
export function keepPropLoops(elements: InteractiveElementInfo[], props: readonly string[] | undefined): void {
  for (const el of elements) {
    for (const s of el.scope ?? []) if (s.fromProp && !props?.includes(s.fromProp)) delete s.fromProp;
  }
}
