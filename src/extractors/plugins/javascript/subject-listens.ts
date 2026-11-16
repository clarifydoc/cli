import type { Node, Tree } from "web-tree-sitter";
import { argumentsOf, holdCallbacks, importSources, inConstructor, injectedLocals, memberTypes, type CellFacts, type SubjectListen } from "./reactive-cells.js";

const CLASS_NODES: ReadonlySet<string> = new Set(["class_declaration", "class", "abstract_class_declaration"]);
const FRAMEWORK_SOURCE = /^(?:@angular\/|rxjs(?:\/|$))/;

function classOf(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (CLASS_NODES.has(p.type)) return p;
  return null;
}

/**
 * What a member's value exposes of another member: `this.a`, `this.a.asObservable()`, `this.a.pipe(…)` (any chain of
 * the two), or the same on a service the class holds — `this.svc.a`, and in a constructor `svc.a`.
 */
export function exposedMember(value: Node, inCtor: boolean): { observes: string; via?: string } | null {
  let n: Node | null = value;
  while (n?.type === "call_expression") {
    const c: Node | null = n.childForFieldName("function");
    const prop = c?.type === "member_expression" ? c.childForFieldName("property")?.text : null;
    if (prop !== "asObservable" && prop !== "pipe") return null;
    n = c!.childForFieldName("object");
  }
  if (n?.type !== "member_expression") return null;
  const observes = n.childForFieldName("property")?.text;
  const holder = n.childForFieldName("object");
  if (!observes) return null;
  if (holder?.type === "this") return { observes };
  if (holder?.type === "member_expression" && holder.childForFieldName("object")?.type === "this") return { observes, via: holder.childForFieldName("property")!.text };
  if (holder?.type === "identifier" && inCtor) return { observes, via: holder.text };
  return null;
}

/** The members a class sets from another member's stream: a field, a getter, a constructor assignment. */
function aliasesOf(cls: Node): Map<string, { observes: string; via?: string }> {
  const out = new Map<string, { observes: string; via?: string }>();
  const add = (name: string | undefined, value: Node | null | undefined, inCtor: boolean) => {
    const found = name && value ? exposedMember(value, inCtor) : null;
    if (name && found && !out.has(name)) out.set(name, found);
  };
  for (const d of cls.descendantsOfType(["public_field_definition", "field_definition"])) {
    if (d && classOf(d)?.id === cls.id) add((d.childForFieldName("name") ?? d.childForFieldName("property"))?.text, d.childForFieldName("value"), false);
  }
  for (const m of cls.descendantsOfType("method_definition")) {
    if (!m || classOf(m)?.id !== cls.id) continue;
    const name = m.childForFieldName("name")?.text;
    if (name === "constructor") {
      for (const as of m.descendantsOfType("assignment_expression")) {
        const left = as?.childForFieldName("left");
        if (as && left?.type === "member_expression" && left.childForFieldName("object")?.type === "this") add(left.childForFieldName("property")?.text, as.childForFieldName("right"), true);
      }
    } else if (name && m.children.some((c) => c?.type === "get")) {
      const returns = m.descendantsOfType("return_statement");
      if (returns.length === 1) add(name, returns[0]?.namedChildren[0], false);
    }
  }
  return out;
}

/** An observable written as `<source>.pipe(op(() => …), …)`: the source and the operator callbacks written in place. */
function pipeSource(expr: Node): { source: Node; operatorCallbacks: Node[] } {
  const operatorCallbacks: Node[] = [];
  let recv: Node = expr;
  while (recv.type === "call_expression") {
    const c = recv.childForFieldName("function");
    if (c?.type !== "member_expression" || c.childForFieldName("property")?.text !== "pipe") break;
    for (const op of argumentsOf(recv)) {
      if (op.type !== "call_expression") continue;
      for (const a of argumentsOf(op)) if ((a.type === "arrow_function" || a.type === "function_expression") && a.descendantsOfType("call_expression").length > 0) operatorCallbacks.push(a);
    }
    recv = c.childForFieldName("object")!;
  }
  return { source: recv, operatorCallbacks };
}

/**
 * Listeners on a service's subject the in-place `this.svc.changes$.pipe(…).subscribe(cb)` reader
 * (`reactive-cells.ts`) does not see, as `SubjectListen`s:
 *
 *  - a subscription through the class's own alias of the stream (`stream$ = this.svc.changes$`, a getter, a
 *    constructor assignment — any chain of aliases): `this.stream$.pipe(…).subscribe(cb)`;
 *  - `toSignal(this.svc.changes$.pipe(switchMap(() => this.http.get(…))))`, which subscribes for the signal's life;
 *  - an observable member read with the `async` pipe in the component's inline template
 *    (`players$ = this.svc.changes$.pipe(…)` and `players$ | async`), which the template subscribes for as long as
 *    the component lives. An external template (`templateUrl`) is not read here.
 *
 * The operator callbacks (and the subscribe callback) are held, so a `next` elsewhere reaches them. The listen names
 * the service member and subject the alias resolves to, which the project pass joins by type.
 */
export function withAngularListeners(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!/\btoSignal\b|\|\s*async\b|\.subscribe\s*\(/.test(text) || !/\b(?:Injectable|Component|Directive|Pipe|NgModule)\b|\binject\s*\(/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const declaredHere = new Set(tree.rootNode.descendantsOfType(["class_declaration", "abstract_class_declaration"]).map((c) => c?.childForFieldName("name")?.text ?? ""));
  const found: SubjectListen[] = [];
  const perClass = new Map<number, { types: Map<string, string>; aliases: Map<string, { observes: string; via?: string }>; locals: Set<string> }>();
  const infoOf = (cls: Node) => perClass.get(cls.id) ?? perClass.set(cls.id, { types: memberTypes(cls), aliases: aliasesOf(cls), locals: injectedLocals(cls) }).get(cls.id)!;
  /** The service member and its subject a stream root names, through the class's aliases: `this.svc.x`, `svc.x` in a constructor, or `this.alias`. */
  const resolve = (root: Node, cls: Node, at: Node): { via: string; field: string } | null => {
    const info = infoOf(cls);
    if (root.type !== "member_expression") return null;
    const holder = root.childForFieldName("object");
    const prop = root.childForFieldName("property")?.text;
    if (!prop) return null;
    if (holder?.type === "this") {
      let name = prop;
      for (let hop = 0; hop < 6; hop++) {
        const alias = info.aliases.get(name);
        if (!alias) return null;
        if (alias.via !== undefined) return { via: alias.via, field: alias.observes };
        name = alias.observes;
      }
      return null;
    }
    if (holder?.type === "member_expression" && holder.childForFieldName("object")?.type === "this") return { via: holder.childForFieldName("property")!.text, field: prop };
    if (holder?.type === "identifier" && (inConstructor(at) || info.locals.has(holder.text))) return { via: holder.text, field: prop };
    return null;
  };
  const accept = (cls: Node, r: { via: string; field: string } | null): r is { via: string; field: string } => {
    if (!r) return false;
    const type = infoOf(cls).types.get(r.via);
    const source = type ? sources.get(type) : undefined;
    // A service imported from the project, or declared in this file; never the framework's or the observable library's.
    return !!type && (source ? !FRAMEWORK_SOURCE.test(source) : declaredHere.has(type));
  };
  const push = (cls: Node, r: { via: string; field: string }, at: Node, callbacks: Array<{ c: Node; hook: string }>) => {
    for (const cb of callbacks) found.push({ callback: cb.c, hook: cb.hook, via: r.via, field: r.field, at, cls });
  };

  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    if (!n) continue;
    const callee = n.childForFieldName("function");
    const cls = classOf(n);
    if (!cls) continue;
    if (callee?.type === "identifier" && callee.text === "toSignal") {
      const arg = argumentsOf(n)[0];
      if (!arg) continue;
      const { source, operatorCallbacks } = pipeSource(arg);
      const r = resolve(source, cls, n);
      if (accept(cls, r) && operatorCallbacks.length > 0) push(cls, r, n, operatorCallbacks.map((c) => ({ c, hook: "pipe" })));
    } else if (callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "subscribe") {
      // `this.stream$.pipe(…).subscribe(cb)` — the in-place reader takes the service-rooted ones.
      let recv = callee.childForFieldName("object");
      const chain: Node[] = [];
      while (recv?.type === "call_expression") {
        const c = recv.childForFieldName("function");
        if (c?.type !== "member_expression" || c.childForFieldName("property")?.text !== "pipe") break;
        chain.push(recv);
        recv = c.childForFieldName("object");
      }
      if (recv?.type !== "member_expression" || recv.childForFieldName("object")?.type !== "this" || !infoOf(cls).aliases.has(recv.childForFieldName("property")!.text)) continue;
      const r = resolve(recv, cls, n);
      if (!accept(cls, r)) continue;
      const { operatorCallbacks } = pipeSource(callee.childForFieldName("object")!);
      const first = argumentsOf(n)[0];
      const sub = first && (first.type === "arrow_function" || first.type === "function_expression") && first.descendantsOfType("call_expression").length > 0 ? first : null;
      push(cls, r, n, [...operatorCallbacks.map((c) => ({ c, hook: "pipe" })), ...(sub ? [{ c: sub, hook: "subscribe" }] : [])]);
    }
  }

  // An observable member the class's inline template reads through `| async`.
  if (/\|\s*async\b/.test(text)) {
    for (const cls of tree.rootNode.descendantsOfType(["class_declaration", "abstract_class_declaration"])) {
      // The component's decorator (with its inline template) is a child of the `export` around an exported class.
      const scope = cls?.parent?.type === "export_statement" ? cls.parent.text : cls?.text ?? "";
      if (!cls || !/\|\s*async\b/.test(scope)) continue;
      const member = (name: string) => new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, "\\$")}\s*\|\s*async\b`).test(scope);
      const consider = (name: string | undefined, value: Node | null | undefined) => {
        if (!name || !value || !member(name)) return;
        const { source, operatorCallbacks } = pipeSource(value);
        if (operatorCallbacks.length === 0) return;
        const r = resolve(source, cls, value);
        if (accept(cls, r)) push(cls, r, value, operatorCallbacks.map((c) => ({ c, hook: "pipe" })));
      };
      for (const d of cls.descendantsOfType(["public_field_definition", "field_definition"])) {
        if (d && classOf(d)?.id === cls.id) consider((d.childForFieldName("name") ?? d.childForFieldName("property"))?.text, d.childForFieldName("value"));
      }
      for (const m of cls.descendantsOfType("method_definition")) {
        if (!m || classOf(m)?.id !== cls.id || !m.children.some((c) => c?.type === "get")) continue;
        const returns = m.descendantsOfType("return_statement");
        if (returns.length === 1) consider(m.childForFieldName("name")?.text, returns[0]?.namedChildren[0]);
      }
    }
  }

  if (found.length === 0) return facts;
  return { ...facts, held: holdCallbacks(facts.held, found), subjectListens: [...(facts.subjectListens ?? []), ...found] };
}
