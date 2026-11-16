import type { Node, Tree } from "web-tree-sitter";
import type { ClassInfo, FileAnalysis, FunctionInfo, PropFlows, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { attributesAfter } from "./prop-bindings.js";
import { reactiveCellsOf } from "./reactive-cells.js";
import { destructuredProps } from "../../shared/destructuring.js";
import { autoImportedComponents, globalComponentFiles, spansOf, tagKey, type SymbolSpan } from "./dispatch.js";

/**
 * How a prop's value moves between components, from both sides (`FileAnalysis.propFlows`):
 *
 *   - the child's callbacks reading `props.<prop>` — a `watch(() => props.query, …)` source, a `watchEffect` body: they
 *     run when a parent changes the value (`watchers`, named as the linker names the callback);
 *   - a Vue parent's tag binding a prop (`<ClubList :query="passedQuery" :api="clubApi" />`): the plain local it names
 *     and the functions writing that local (`passedQuery.value = x`); any other value is kept as a binding without a
 *     local, because a prop's type is the parent's value only when EVERY binding of it agrees (`bindings`).
 *
 * `JsPropFlowResolver` joins them: the parent's write → the child's watcher (a dispatch link), and a call through a
 * prop (`props.api.load()`) → the member of the value every parent hands down.
 */
export function propFlows(tree: Tree, _sourceText: string, rawSource: string, filePath: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): PropFlows | null {
  const out: PropFlows = {};
  const facts = reactiveCellsOf(tree);
  const declared = new Set(functions.map((f) => f.name));
  const watchers: NonNullable<PropFlows["watchers"]> = [];
  for (const t of facts.propTriggers ?? []) {
    const name = t.callback ? facts.held.get(t.callback.id) : t.callee && declared.has(t.callee) ? t.callee : undefined;
    if (!name || !declared.has(name)) continue;
    const line = t.at.startPosition.row + 1;
    const registeredBy = t.heldHere ? { function: innermost(functions.filter((f) => !/^<\w+@\d+/.test(f.name)), line) ?? "<setup>", hook: t.hook } : undefined;
    for (const prop of t.props) if (!watchers.some((w) => w.prop === prop && w.function === name)) watchers.push({ prop, function: name, line, ...(registeredBy ? { registeredBy } : {}) });
  }
  if (watchers.length > 0) out.watchers = watchers;
  if (filePath.endsWith(".vue")) {
    const bindings = vueValueBindings(tree, rawSource, functions);
    if (bindings.length > 0) out.bindings = bindings;
  }
  const known = knownNames(tree, functions);
  if (!filePath.endsWith(".vue") && rawSource.includes("<")) {
    const bindings = jsxValueBindings(tree, functions, known);
    if (bindings.length > 0) out.bindings = bindings;
  }
  const argLocals = typedLocalArguments(tree, functions, known);
  if (argLocals.length > 0) out.argLocals = argLocals;
  return out.watchers || out.bindings || out.argLocals ? out : null;
}

const FUNCTION_NODES = ["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "function"];

function enclosingFunction(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (FUNCTION_NODES.includes(p.type)) return p;
  return null;
}

/** `Club`, `Club | null | undefined` → `Club`; anything else (a union of classes, a generic, an object type) is none. */
function singleTypeName(text: string): string | undefined {
  const parts = text.split("|").map((t) => t.trim()).filter((t) => t && t !== "null" && t !== "undefined");
  return parts.length === 1 && /^[A-Za-z_$][\w$]*$/.test(parts[0]!) ? parts[0] : undefined;
}

/** What `useState(init)` holds: the type argument, else the class an initializer constructs or the factory it calls (also inside a lazy `() => …`). */
function useStateValue(call: Node): { type?: string; factory?: string } | null {
  const typeArgs = call.childForFieldName("type_arguments");
  if (typeArgs) {
    const inner = typeArgs.namedChildren.filter((c): c is Node => !!c);
    const named = inner.length === 1 ? singleTypeName(inner[0]!.text) : undefined;
    return named ? { type: named } : null;
  }
  let init = call.childForFieldName("arguments")?.namedChild(0) ?? null;
  if (init && (init.type === "arrow_function" || init.type === "function_expression")) {
    const body = init.childForFieldName("body");
    init = body?.type === "statement_block" ? null : body ?? null;
  }
  while (init?.type === "parenthesized_expression") init = init.namedChild(0);
  if (!init) return null;
  if (init.type === "new_expression") {
    const ctor = init.childForFieldName("constructor");
    return ctor?.type === "identifier" ? { type: ctor.text } : null;
  }
  if (init.type === "call_expression") {
    const callee = init.childForFieldName("function");
    return callee?.type === "identifier" ? { factory: callee.text } : null;
  }
  return null;
}

/**
 * React: `<ClubPanel api={api} />` binds a prop to a local of the parent. A local from `const [api] = useState(…)` states
 * what it holds (`state`); any other local is typed by the importing pass from the parent's own typed locals.
 */
function jsxValueBindings(tree: Tree, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, known: ReadonlySet<string>): NonNullable<PropFlows["bindings"]> {
  const out: NonNullable<PropFlows["bindings"]> = [];
  for (const el of tree.rootNode.descendantsOfType(["jsx_opening_element", "jsx_self_closing_element"])) {
    const tag = el?.childForFieldName("name")?.text ?? "";
    // Only a component the file declares or imports: a library's `<Fragment>` or a DOM-ish tag is no project component.
    if (!el || !/^[A-Z][\w$]*$/.test(tag) || !known.has(tag)) continue;
    const useLine = el.startPosition.row + 1;
    const fn = innermost(functions, useLine) ?? undefined;
    // One marker per use of the tag, so a parent that leaves a prop out counts against its type; a spread (`{...rest}`) states none.
    out.push({ component: tag, prop: "*", line: useLine, local: "", writes: [] });
    for (const attr of el.namedChildren) {
      if (attr?.type === "jsx_expression" || attr?.type === "jsx_spread_attribute") {
        out.push({ component: tag, prop: "...", line: attr.startPosition.row + 1, local: "", writes: [] });
        continue;
      }
      if (attr?.type !== "jsx_attribute") continue;
      const name = attr.namedChild(0);
      const value = attr.namedChild(1);
      if (name?.type !== "property_identifier" || NOT_PROPS.has(name.text) || /^on[A-Z]/.test(name.text)) continue;
      const expr = value?.type === "jsx_expression" ? value.namedChild(0) : null;
      const line = attr.startPosition.row + 1;
      if (expr?.type !== "identifier") {
        out.push({ component: tag, prop: name.text, line, local: "", writes: [] });
        continue;
      }
      const state = useStateOf(expr);
      out.push({ component: tag, prop: name.text, line, local: expr.text, writes: [], ...(state ? { state } : {}), ...(fn ? { function: fn } : {}) });
    }
  }
  return out;
}

/** The names a file imports (a default, a named or renamed import — never a namespace) and the functions it declares. */
function knownNames(tree: Tree, functions: ReadonlyArray<{ name: string }>): Set<string> {
  const out = new Set<string>(functions.map((f) => f.name));
  for (const spec of tree.rootNode.descendantsOfType("import_specifier")) {
    const local = spec?.childForFieldName("alias") ?? spec?.childForFieldName("name");
    if (local) out.add(local.text);
  }
  for (const clause of tree.rootNode.descendantsOfType("import_clause")) {
    for (const c of clause?.namedChildren ?? []) if (c?.type === "identifier") out.add(c.text);
  }
  return out;
}

/**
 * The `useState` that declares `ident` (first element of its pair) in the nearest function around the use that declares
 * the name — a render helper or a `.map` callback reads its component's state — when exactly one does.
 */
function useStateOf(ident: Node): { type?: string; factory?: string } | null {
  for (let scope = enclosingFunction(ident); scope; scope = enclosingFunction(scope)) {
    const found: Node[] = [];
    for (const d of scope.descendantsOfType("variable_declarator")) {
      const target = d?.childForFieldName("name");
      if (!d || target?.type !== "array_pattern") continue;
      if (target.namedChild(0)?.text !== ident.text) continue;
      found.push(d);
    }
    if (found.length === 0) continue;
    if (found.length !== 1) return null;
    const value = found[0]!.childForFieldName("value");
    const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
    if (!value || !callee || !/^(?:React\.)?useState$/.test(callee.text)) return null;
    return useStateValue(value);
  }
  return null;
}

/**
 * `refresh(api)`: a call of a function the file declares or imports, by plain name, with its arguments by position — a
 * local's name, null for anything else (a literal, a member, a call result, a missing argument). The callee's `any`
 * parameter is typed from them when every call agrees (`JsParamTypeResolver`), so a call passing something no fact types
 * counts against the type like one passing another class.
 */
function typedLocalArguments(tree: Tree, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, known: ReadonlySet<string>): NonNullable<PropFlows["argLocals"]> {
  const out: NonNullable<PropFlows["argLocals"]> = [];
  const seen = new Set<string>();
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = call?.childForFieldName("function");
    if (!call || callee?.type !== "identifier" || !known.has(callee.text)) continue;
    const list = call.childForFieldName("arguments");
    if (!list) continue;
    const args = list.namedChildren.filter((a): a is Node => !!a).map((a) => (a.type === "identifier" && a.text !== "undefined" ? a.text : null));
    const line = call.startPosition.row + 1;
    const fn = innermost(functions, line) ?? "<setup>";
    // A function states its own call once per callee and arguments: the same site twice adds no fact.
    const id = `${fn}\0${callee.text}\0${args.join(",")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ callee: callee.text, line, function: fn, args });
  }
  // A name read as a value — an argument, an array element, a property, an assigned or returned value, `onClick={refresh}` —
  // is called by whatever receives it, with arguments no call site here states.
  const byReference = (n: Node | null | undefined) => {
    if (!n || (n.type !== "identifier" && n.type !== "shorthand_property_identifier") || !known.has(n.text)) return;
    const line = n.startPosition.row + 1;
    const fn = innermost(functions, line) ?? "<setup>";
    const id = `${fn}\0${n.text}\0ref`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ callee: n.text, line, function: fn, args: [], reference: true });
  };
  for (const n of tree.rootNode.descendantsOfType(["arguments", "array", "jsx_expression", "return_statement", "object", "pair", "variable_declarator", "assignment_expression"])) {
    if (!n) continue;
    if (n.type === "pair") byReference(n.childForFieldName("value"));
    else if (n.type === "variable_declarator") byReference(n.childForFieldName("value"));
    else if (n.type === "assignment_expression") byReference(n.childForFieldName("right"));
    else for (const c of n.namedChildren) byReference(c);
  }
  return out;
}

const NOT_PROPS: ReadonlySet<string> = new Set(["key", "ref", "class", "style", "is", "id", "slot"]);

function vueValueBindings(tree: Tree, raw: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): NonNullable<PropFlows["bindings"]> {
  const start = raw.search(/<template\b/i);
  const end = raw.lastIndexOf("</template>");
  if (start < 0 || end < start) return [];
  const template = raw.slice(start, end);
  const lineAt = (offset: number) => raw.slice(0, start + offset).split("\n").length;
  const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const out: NonNullable<PropFlows["bindings"]> = [];
  const scoped = templateScopeNames(template);
  const writesOf = new Map<string, NonNullable<PropFlows["bindings"]>[number]["writes"]>();
  for (const tag of template.matchAll(/<([A-Z][\w]*|[a-z][\w]*-[\w-]*)(?=[\s/>])/g)) {
    for (const a of attributesAfter(template, tag.index! + tag[0].length)) {
      const bound = /^(?::|v-bind:)([\w-]+)$/.exec(a.name);
      if (!bound) continue;
      const prop = camel(bound[1]!);
      if (NOT_PROPS.has(prop)) continue;
      const value = a.value.trim();
      const line = lineAt(a.offset);
      if (!/^[A-Za-z_$][\w$]*$/.test(value) || scoped.has(value)) {
        out.push({ component: tag[1]!, prop, line, local: "", writes: [] });
        continue;
      }
      let writes = writesOf.get(value);
      if (!writes) writesOf.set(value, (writes = refWrites(tree, value, functions)));
      out.push({ component: tag[1]!, prop, line, local: value, writes });
    }
  }
  return out;
}

/** Names the template itself declares (`v-for="club in clubs"`, `#default="{ club }"`, `slot-scope`): not the script's locals. */
function templateScopeNames(template: string): Set<string> {
  const out = new Set<string>();
  const declare = (expr: string) => {
    for (const m of expr.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
  };
  for (const m of template.matchAll(/\bv-for\s*=\s*"([^"]*?)\s+(?:in|of)\s/g)) declare(m[1]!);
  for (const m of template.matchAll(/(?:\s#[\w-]+|\bv-slot(?::[\w-]+)?|\bslot-scope)\s*=\s*"([^"]*)"/g)) declare(m[1]!);
  return out;
}

/** The functions assigning a ref's value (`passedQuery.value = x`, `passedQuery.value += 1`), by the function around the write. */
function refWrites(tree: Tree, local: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): NonNullable<PropFlows["bindings"]>[number]["writes"] {
  const out: NonNullable<PropFlows["bindings"]>[number]["writes"] = [];
  for (const n of tree.rootNode.descendantsOfType(["assignment_expression", "augmented_assignment_expression", "update_expression"])) {
    if (!n) continue;
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    if (left?.type !== "member_expression" || left.childForFieldName("property")?.text !== "value") continue;
    const object = left.childForFieldName("object");
    if (object?.type !== "identifier" || object.text !== local) continue;
    const line = n.startPosition.row + 1;
    const fn = innermost(functions, line);
    if (fn && !out.some((w) => w.function === fn && w.line === line)) out.push({ function: fn, line, spelling: local });
  }
  return out;
}

function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}

type Binding = NonNullable<PropFlows["bindings"]>[number];

/** A value's type as its file knows it: a class, or the factory whose result it is (`const clubApi = useClubApi()`). */
export interface TypedValue {
  file: FileAnalysis;
  /** The class declaring the members, or the function returning them. */
  owner: { kind: "class"; cls: ClassInfo } | { kind: "factory"; fn: FunctionInfo };
  id: string;
}

export type Files = { byPath: Map<string, FileAnalysis>; filePathMap: Map<string, string> };

/** The file declaring a class or function: `file` itself, or the module its import of `name` resolves to (under the exported name). */
export function homeOf(file: FileAnalysis, name: string, kind: "class" | "function", files: Files): { file: FileAnalysis; name: string } | null {
  const declares = (a: FileAnalysis, n: string) => (kind === "class" ? a.classes.some((c) => c.name === n) : a.functions.some((f) => f.name === n));
  if (declares(file, name)) return { file, name };
  const imp = file.imports.find((i) => i.specifiers.includes(name));
  if (!imp) return null;
  let exported = imp.aliases?.[name] ?? name;
  const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
  const at = target ? files.byPath.get(target) : undefined;
  // A default import is whatever the module exports by default (`export default function useClubApi`).
  if (at && exported === "default") exported = at.exports.find((e) => e.kind === "default" && e.name !== "default")?.name ?? exported;
  return at && declares(at, exported) ? { file: at, name: exported } : null;
}

/** The typed value a factory call or a local stands for, or null when it is not one a single fact settles. */
export function typedValueOf(file: FileAnalysis, ref: { factory?: string; local?: string; type?: string; in?: string }, files: Files): TypedValue | null {
  let factory = ref.factory;
  let type: string | undefined = ref.type;
  if (ref.local) {
    // `in`: the function the name is read in — a namesake local of another function is no evidence.
    const entries = file.functions.filter((f) => ref.in === undefined || f.name === ref.in).flatMap((f) => (f.localTypes ?? []).filter((l) => l.name === ref.local));
    if (entries.length !== 1) return null;
    const e = entries[0]!;
    if (e.destructured || e.element || e.iterator || e.member || e.field || e.aliasOf) return null;
    if (e.type) type = e.type;
    else {
      const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e.from ?? "");
      if (!m) return null;
      factory = m[1];
    }
  }
  if (type && /^[A-Za-z_$][\w$]*$/.test(type)) {
    const home = homeOf(file, type, "class", files);
    const cls = home?.file.classes.find((c) => c.name === home.name);
    return home && cls ? { file: home.file, owner: { kind: "class", cls }, id: `${home.file.filePath}#${home.name}` } : null;
  }
  if (!factory) return null;
  const home = homeOf(file, factory, "function", files);
  const fns = home?.file.functions.filter((f) => f.name === home.name) ?? [];
  return home && fns.length === 1 ? { file: home.file, owner: { kind: "factory", fn: fns[0]! }, id: `${home.file.filePath}#${home.name}` } : null;
}

/** The member `member` of a typed value: a class method, or the function a factory returns under that key. */
export function memberOf(value: TypedValue, member: string): { file: FileAnalysis; span: SymbolSpan } | null {
  const spans = spansOf(value.file);
  const owner = value.owner;
  if (owner.kind === "class") {
    const span = spans.find((sp) => sp.symbol === `${owner.cls.name}.${member}`);
    return span ? { file: value.file, span } : null;
  }
  const fn = owner.fn;
  const entry = fn.returnedMembers?.find((m) => m.key === member && m.kind === "function" && m.local);
  if (!entry?.local) return null;
  const named = spans.filter((sp) => sp.symbol === entry.local);
  const span = named.find((sp) => sp.line >= fn.line && sp.endLine <= fn.endLine) ?? null;
  return span ? { file: value.file, span } : null;
}

/** The files that render a component, by tag, and the child file each tag names. */
function childFileOf(parent: FileAnalysis, component: string, ctx: { globals: Map<string, string>; autoImported: Map<string, Map<string, string>>; files: Files }): FileAnalysis | null {
  const byKey = new Map<string, string>([...(ctx.autoImported.get(parent.projectId ?? "") ?? []), ...ctx.globals]);
  for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) byKey.set(tagKey(sub.name), sub.importSource);
  const src = byKey.get(tagKey(component));
  const file = src ? resolveTarget(src, parent.filePath, ctx.files.filePathMap) : null;
  return file ? ctx.files.byPath.get(file) ?? null : null;
}

/**
 * A prop's value across components, from `FileAnalysis.propFlows`:
 *
 *   - a parent function writing the ref bound to a prop (`passedQuery.value = x`) runs the callbacks of the child watching
 *     that prop: a `dispatch:prop-trigger` link from the writing function to the child's watcher;
 *   - a call through a prop (`props.api.load()`) is a call on the value every parent binds to it (`const clubApi =
 *     useClubApi()`): one link to the member of that value. A prop bound by one parent to something else, to anything the
 *     file cannot type, or to a different type is left untyped.
 */
export class JsPropFlowResolver implements DispatchResolver {
  readonly id = "prop-flow";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 34;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const push = (link: SymbolLink) => {
      const id = `${link.sourceFile}\0${link.sourceSymbol}\0${link.sourceLine}\0${link.callName}\0${link.targetFile}\0${link.targetSymbol}`;
      if (!seen.has(id)) (seen.add(id), links.push(link));
    };
    // A watcher split out of its component's function for the props it reads is still run by the function that registers it.
    for (const a of analyses) {
      for (const w of a.propFlows?.watchers ?? []) {
        if (!w.registeredBy) continue;
        push({
          sourceFile: a.filePath,
          sourceSymbol: w.registeredBy.function,
          sourceLine: w.line,
          callName: w.registeredBy.hook,
          targetFile: a.filePath,
          targetSymbol: w.function,
          targetLine: a.functions.find((f) => f.name === w.function)?.line ?? w.line,
          confidence: "INFERRED",
          strategy: "dispatch:prop-watcher",
          relation: "dispatch",
        });
      }
    }
    if (!analyses.some((a) => a.propFlows?.bindings?.length)) return links;
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    const ctx = { globals: globalComponentFiles(analyses, files.filePathMap), autoImported: autoImportedComponents(analyses), files };
    // child file → prop → the parents' bindings of it.
    const bound = new Map<string, Map<string, Array<{ parent: FileAnalysis; binding: Binding }>>>();
    // A React component: `<file>#<function>` → prop → the parents' bindings of it.
    // `uses`: how many tags rendered it (a prop is typed only when every one binds it); `spread`: a tag handed props it does not name.
    const reactBound = new Map<string, { file: FileAnalysis; fn: FunctionInfo; uses: number; spread: boolean; byProp: Map<string, Array<{ parent: FileAnalysis; binding: Binding }>> }>();
    for (const parent of analyses) {
      for (const b of parent.propFlows?.bindings ?? []) {
        if (!parent.filePath.endsWith(".vue")) {
          const home = homeOf(parent, b.component, "function", files);
          const fns = home?.file.functions.filter((f) => f.name === home.name) ?? [];
          if (home && fns.length === 1) {
            const key = `${home.file.filePath}#${home.name}`;
            const entry = reactBound.get(key) ?? reactBound.set(key, { file: home.file, fn: fns[0]!, uses: 0, spread: false, byProp: new Map() }).get(key)!;
            if (b.prop === "*") entry.uses++;
            else if (b.prop === "...") entry.spread = true;
            else (entry.byProp.get(b.prop) ?? entry.byProp.set(b.prop, []).get(b.prop)!).push({ parent, binding: b });
          }
          continue;
        }
        const child = childFileOf(parent, b.component, ctx);
        if (!child || child === parent) continue;
        const byProp = bound.get(child.filePath) ?? bound.set(child.filePath, new Map()).get(child.filePath)!;
        (byProp.get(b.prop) ?? byProp.set(b.prop, []).get(b.prop)!).push({ parent, binding: b });
      }
    }
    // The type of a prop: the value every parent binds to it, when they all agree.
    const typeOfBindings = (entries: Array<{ parent: FileAnalysis; binding: Binding }> | undefined): TypedValue | null => {
      const values = (entries ?? []).map(({ parent, binding }) =>
        binding.state ? typedValueOf(parent, binding.state, files) : binding.local ? typedValueOf(parent, { local: binding.local, ...(binding.function ? { in: binding.function } : {}) }, files) : null,
      );
      return values.length > 0 && values.every((v) => v && v.id === values[0]!.id) ? values[0]! : null;
    };
    const linkMember = (file: FileAnalysis, fnName: string, call: { name: string; line: number }, value: TypedValue | null, member: string) => {
      const hit = value ? memberOf(value, member) : null;
      if (!hit) return;
      push({
        sourceFile: file.filePath,
        sourceSymbol: fnName,
        sourceLine: call.line,
        callName: call.name,
        targetFile: hit.file.filePath,
        targetSymbol: hit.span.symbol,
        targetLine: hit.span.line,
        confidence: "INFERRED",
        strategy: "dispatch:prop-type",
        relation: "dispatch",
      });
    };
    // A React component takes its props as a parameter: `{ api }` / `{ api: client }`, or `props` read as `props.api.load()`.
    for (const { file: child, fn: component, byProp, uses, spread } of reactBound.values()) {
      if (spread) continue;
      const pattern = component.params[0]?.name ?? "";
      const locals = new Map<string, string>(); // local name → prop
      for (const [prop, local] of destructuredProps(pattern)) if (local) locals.set(local, prop);
      const propsName = /^[A-Za-z_$][\w$]*$/.test(pattern) ? pattern : null;
      if (locals.size === 0 && !propsName) continue;
      const typed = new Map<string, TypedValue | null>();
      const valueOf = (prop: string) => {
        if (!typed.has(prop)) {
          const entries = byProp.get(prop);
          typed.set(prop, entries && entries.length === uses ? typeOfBindings(entries) : null);
        }
        return typed.get(prop)!;
      };
      for (const fn of child.functions) {
        if (fn.line < component.line || fn.endLine > component.endLine) continue;
        const own = fn !== component ? new Set(fn.params.map((p) => p.name)) : new Set<string>();
        for (const call of fn.calls) {
          if (call.boundLocally) continue;
          const parts = call.name.split(".");
          if (parts.length === 2 && locals.has(parts[0]!) && !own.has(parts[0]!)) linkMember(child, fn.name, call, valueOf(locals.get(parts[0]!)!), parts[1]!);
          else if (parts.length === 3 && propsName && parts[0] === propsName && !own.has(propsName)) linkMember(child, fn.name, call, valueOf(parts[1]!), parts[2]!);
        }
      }
    }
    for (const child of analyses) {
      const byProp = bound.get(child.filePath);
      if (!byProp) continue;
      const lineOf = (name: string) => child.functions.find((f) => f.name === name)?.line;
      for (const w of child.propFlows?.watchers ?? []) {
        const target = lineOf(w.function);
        if (target === undefined) continue;
        for (const { parent, binding } of byProp.get(w.prop) ?? []) {
          for (const write of binding.writes) {
            push({
              sourceFile: parent.filePath,
              sourceSymbol: write.function,
              sourceLine: write.line,
              callName: write.spelling,
              targetFile: child.filePath,
              targetSymbol: w.function,
              targetLine: target,
              confidence: "INFERRED",
              strategy: "dispatch:prop-trigger",
              relation: "dispatch",
            });
          }
        }
      }
      // `props.api.load()` where `const props = defineProps<…>()`.
      const aliases = new Set(child.functions.flatMap((f) => (f.localTypes ?? []).filter((l) => /^(?:withDefaults\(\s*)?defineProps\b/.test(l.from ?? "")).map((l) => l.name)));
      // A prop called by its bare name — only the template can (`@click="api.load()"`), unless the script declares a name of its own.
      const bare = child.filePath.endsWith(".vue") ? new Set((child.declaredProps ?? []).filter((p) => !child.functions.some((f) => f.name === p || (f.localTypes ?? []).some((l) => l.name === p)))) : new Set<string>();
      if (aliases.size === 0 && bare.size === 0) continue;
      const fns: FunctionInfo[] = [...child.functions, ...child.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      const typedProp = new Map<string, TypedValue | null>();
      const valueOf = (prop: string) => (typedProp.has(prop) ? typedProp.get(prop)! : (typedProp.set(prop, typeOfBindings(byProp.get(prop))), typedProp.get(prop)!));
      for (const fn of fns) {
        for (const call of fn.calls) {
          if (call.boundLocally) continue;
          const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(call.name);
          if (m && aliases.has(m[1]!)) {
            linkMember(child, fn.name, call, valueOf(m[2]!), m[3]!);
            continue;
          }
          const b = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(call.name);
          if (b && bare.has(b[1]!)) linkMember(child, fn.name, call, valueOf(b[1]!), b[2]!);
        }
      }
    }
    return links;
  }
}

const UNTYPED = new Set(["", "any", "unknown"]);

/**
 * A parameter declared `any`, `unknown` or not at all, typed from what its callers pass (`refresh(api: any)` ←
 * `refresh(clubApi)` with `const clubApi = new ClubApi()`): a call on the parameter (`api.load()`) is a call on the value
 * every call site hands it — the same type from all of them, each argument a local the caller's file types. One call site that
 * passes anything else (an argument no fact types, another class, no argument) gives the parameter no type; so does a
 * function the project never calls by its plain name. A callee's own `const api = …` rebinding or a nested function taking
 * the same name as its parameter leaves the call alone.
 */
export class JsParamTypeResolver implements DispatchResolver {
  readonly id = "param-type";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 36;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.propFlows?.argLocals?.length)) return [];
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    // `<file>#<function>` → every call site naming it: the caller's file and the identifier arguments by position.
    const sites = new Map<string, Array<{ file: FileAnalysis; args: Array<string | null>; function: string; reference?: true }>>();
    for (const caller of analyses) {
      for (const c of caller.propFlows?.argLocals ?? []) {
        const home = homeOf(caller, c.callee, "function", files);
        if (!home) continue;
        const key = `${home.file.filePath}#${home.name}`;
        (sites.get(key) ?? sites.set(key, []).get(key)!).push({ file: caller, args: c.args, function: c.function, ...(c.reference ? { reference: true } : {}) });
      }
    }
    // A function handed on by name (`onClick={refresh}`, `items.map(refresh)`) is called by whatever receives it.
    const handedOn = new Set<string>();
    for (const [key, calls] of sites) if (calls.some((c) => c.reference)) handedOn.add(key);
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const [key, calls] of sites) {
      const hash = key.lastIndexOf("#");
      const file = files.byPath.get(key.slice(0, hash));
      const fns = file?.functions.filter((f) => f.name === key.slice(hash + 1)) ?? [];
      if (!file || fns.length !== 1 || handedOn.has(key)) continue;
      const callee = fns[0]!;
      callee.params.forEach((param, index) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(param.name) || !UNTYPED.has((param.type ?? "").trim())) return;
        // Rebinding the name in the body (`api = other`) or a typed local of that name is another value.
        if ((callee.localTypes ?? []).some((l) => l.name === param.name && !UNTYPED.has(l.type.trim()))) return;
        const values = calls.map((c) => {
          const name = c.args[index];
          return name ? typedValueOf(c.file, { local: name, in: c.function }, files) : null;
        });
        const first = values[0];
        if (!first || values.some((v) => !v || v.id !== first.id)) return;
        for (const fn of file.functions) {
          if (fn.line < callee.line || fn.endLine > callee.endLine) continue;
          if (fn !== callee && fn.params.some((p) => p.name === param.name)) continue;
          for (const call of fn.calls) {
            if (call.boundLocally) continue;
            const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(call.name);
            if (!m || m[1] !== param.name) continue;
            const hit = memberOf(first, m[2]!);
            if (!hit) continue;
            const id = `${fn.name}\0${call.line}\0${call.name}`;
            if (seen.has(`${file.filePath}\0${id}`)) continue;
            seen.add(`${file.filePath}\0${id}`);
            links.push({
              sourceFile: file.filePath,
              sourceSymbol: fn.name,
              sourceLine: call.line,
              callName: call.name,
              targetFile: hit.file.filePath,
              targetSymbol: hit.span.symbol,
              targetLine: hit.span.line,
              confidence: "INFERRED",
              strategy: "dispatch:param-type",
              relation: "dispatch",
            });
          }
        }
      });
    }
    return links;
  }
}


/**
 * Vue's provide/inject by TYPE: `provide(LeagueKey, useLeague())` in an ancestor, `const league = inject(LeagueKey)` below it,
 * `league.relegate()` — a call on the value the key carries, so it links to that member. The key is a literal or an imported
 * symbol (resolved to its declaration, so two modules' `Key` are two keys); the provided value is a factory called in place or
 * a local typed by its initializer. Providers of one key that disagree about the value, or that no fact types, give no type.
 */
export class JsContextTypeResolver implements DispatchResolver {
  readonly id = "provide-inject-typed";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.contextValues?.some((v) => v.kind === "inject-typed"))) return [];
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    const keyOf = (a: FileAnalysis, v: { key: string; keyRef?: true }): string | null => {
      if (!v.keyRef) return `${a.projectId ?? ""}\0str:${v.key}`;
      const home = declarationOf(a, v.key, files);
      return home ? `${a.projectId ?? ""}\0${home}` : null;
    };
    // key → what each provider hands on (null: nothing typed).
    const providers = new Map<string, Array<{ file: FileAnalysis; value: TypedValue | null }>>();
    for (const a of analyses) {
      for (const v of a.contextValues ?? []) {
        if (v.kind !== "provide-typed") continue;
        const key = keyOf(a, v);
        if (!key) continue;
        const value = typedValueOf(a, v.factory ? { factory: v.name } : { local: v.name }, files);
        (providers.get(key) ?? providers.set(key, []).get(key)!).push({ file: a, value });
      }
    }
    if (providers.size === 0) return [];
    const links: SymbolLink[] = [];
    for (const a of analyses) {
      for (const v of a.contextValues ?? []) {
        if (v.kind !== "inject-typed") continue;
        const key = keyOf(a, v);
        const candidates = (key ? providers.get(key) ?? [] : []).filter((p) => p.file !== a);
        const first = candidates[0]?.value;
        if (!first || candidates.some((p) => p.value?.id !== first.id)) continue;
        const fns: FunctionInfo[] = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
        const prefix = `${v.name}.`;
        const done = new Set<string>();
        const link = (symbol: string, line: number, callName: string, member: string) => {
          const hit = memberOf(first, member);
          const id = `${symbol}\0${line}\0${callName}`;
          if (!hit || done.has(id)) return;
          done.add(id);
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: symbol,
            sourceLine: line,
            callName,
            targetFile: hit.file.filePath,
            targetSymbol: hit.span.symbol,
            targetLine: hit.span.line,
            confidence: "INFERRED",
            strategy: "dispatch:provide-inject-type",
            relation: "dispatch",
          });
        };
        let inFunctions = false;
        for (const fn of fns) {
          for (const call of fn.calls) {
            if (call.boundLocally || !call.name.startsWith(prefix)) continue;
            const member = call.name.slice(prefix.length);
            if (!/^[A-Za-z_$][\w$]*$/.test(member)) continue;
            inFunctions = true;
            link(fn.name, call.line, call.name, member);
          }
        }
        // Only the markup calls it (`@click="league.relegate()"`).
        if (inFunctions) continue;
        const inMarkup = new RegExp(`^(?:void\\s+|await\\s+)?${v.name.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`);
        for (const el of a.interactiveElements ?? []) {
          const m = el.handler ? inMarkup.exec(el.handler.trim()) : null;
          if (m) link("<template>", el.line, `${v.name}.${m[1]}`, m[1]!);
        }
      }
    }
    return links;
  }
}

/** The declaration a name used as a key stands for: `<file>#<exported name>`, in the file declaring it or the module it imports it from. */
function declarationOf(file: FileAnalysis, name: string, files: Files): string | null {
  const imp = file.imports.find((i) => i.specifiers.includes(name));
  if (!imp) return `${file.filePath}#${name}`;
  const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
  return target ? `${target}#${imp.aliases?.[name] ?? name}` : null;
}
