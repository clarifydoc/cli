import type { Node, Tree } from "web-tree-sitter";
import {
  argumentsOf, callbackOf, FRAMEWORK_SOURCE, holdCallbacks, importSources, inConstructor, injectedLocals, memberTypes, ownerClass as classOf,
  pipeSource, subscribeChain, type CellFacts, type SubjectListen,
} from "./reactive-cells.js";

const NAMED_CLASSES = ["class_declaration", "abstract_class_declaration"];

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

/**
 * Listeners on a service's subject the in-place `this.svc.changes$.pipe(…).subscribe(cb)` reader
 * (`reactive-cells.ts`) does not see, as `SubjectListen`s:
 *
 *  - a subscription through the class's own alias of the stream (`stream$ = this.svc.changes$`, a getter, a
 *    constructor assignment — any chain of aliases): `this.stream$.pipe(…).subscribe(cb)`;
 *  - `toSignal(this.svc.changes$.pipe(switchMap(() => this.http.get(…))))`, which subscribes for the signal's life;
 *  - an observable member read with the `async` pipe in the component's inline template
 *    (`players$ = this.svc.changes$.pipe(…)` and `players$ | async`), which the template subscribes for as long as
 *    the component lives. An external template (`templateUrl`) is read by the project pass (`angular-external-templates.ts`), which keeps
 *    only the members it pipes through `async`.
 *  - the same member assigned in the constructor (`this.players$ = this.svc.changes$.pipe(…)`).
 *
 * The operator callbacks (and the subscribe callback) are held, so a `next` elsewhere reaches them. The listen names
 * the service member and subject the alias resolves to, which the project pass joins by type.
 */
export function withAngularListeners(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!/\btoSignal\b|\|\s*async\b|\btemplateUrl\b|\.subscribe\s*\(/.test(text) || !/\b(?:Injectable|Component|Directive|Pipe|NgModule)\b|\binject\s*\(/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const classes = tree.rootNode.descendantsOfType(NAMED_CLASSES).filter((c): c is Node => c !== null);
  const declaredHere = new Set(classes.map((c) => c.childForFieldName("name")?.text ?? ""));
  const found: SubjectListen[] = [];
  const perClass = new Map<number, { types: Map<string, string>; aliases: Map<string, { observes: string; via?: string }>; locals: Set<string> }>();
  const infoOf = (cls: Node) => perClass.get(cls.id) ?? perClass.set(cls.id, { types: memberTypes(cls), aliases: aliasesOf(cls), locals: injectedLocals(cls) }).get(cls.id)!;
  /** The service member and its subject a stream root names, through the class's aliases: `this.svc.x`, `svc.x` in a constructor, or `this.alias`. */
  const resolve = (root: Node, cls: Node, at: Node): { via: string; field: string } | null => {
    if (root.type !== "member_expression") return null;
    const holder = root.childForFieldName("object");
    const prop = root.childForFieldName("property")?.text;
    if (!prop) return null;
    const info = infoOf(cls);
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
  /**
   * A listener on `root`: its operator callbacks (and the subscriber's, when one is written in place), when the root
   * resolves to a subject of a service imported from the project or declared in this file — never the framework's.
   */
  const listen = (cls: Node, root: Node, at: Node, operatorCallbacks: Node[], subscriber?: Node | null) => {
    const r = resolve(root, cls, at);
    const type = r ? infoOf(cls).types.get(r.via) : undefined;
    const source = type ? sources.get(type) : undefined;
    if (!r || !type || (source ? FRAMEWORK_SOURCE.test(source) : !declaredHere.has(type))) return;
    for (const c of operatorCallbacks) found.push({ callback: c, hook: "pipe", via: r.via, field: r.field, at, cls });
    if (subscriber) found.push({ callback: subscriber, hook: "subscribe", via: r.via, field: r.field, at, cls });
  };

  const signals = text.includes("toSignal");
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    if (!n) continue;
    const callee = n.childForFieldName("function");
    if (signals && callee?.type === "identifier" && callee.text === "toSignal") {
      const cls = classOf(n);
      const arg = argumentsOf(n)[0];
      if (!cls || !arg) continue;
      const { source, operatorCallbacks } = pipeSource(arg);
      listen(cls, source, n, operatorCallbacks);
      continue;
    }
    // `this.stream$.pipe(…).subscribe(cb)` through an own alias — the in-place reader takes the service-rooted ones.
    const chain = subscribeChain(n);
    if (chain?.root.type !== "member_expression" || chain.root.childForFieldName("object")?.type !== "this") continue;
    const cls = classOf(n);
    if (!cls) continue;
    const first = callbackOf(argumentsOf(n)[0]).callback;
    listen(cls, chain.root, n, chain.operatorCallbacks, first && first.descendantsOfType("call_expression").length > 0 ? first : null);
  }

  // An observable member the class's template reads through `| async`: an inline template is read here; an external
  // one (`templateUrl`) is read by the project pass, so every stream member of such a class is a candidate, marked
  // `pendingMember`, and the pass drops the ones the template does not pipe.
  if (/\|\s*async\b|\btemplateUrl\b/.test(text)) {
    for (const cls of classes) {
      const { members: read, external } = asyncPipeMembers(cls);
      if (read.size === 0 && !external) continue;
      const consider = (name: string | undefined, value: Node | null | undefined) => {
        if (!name || !value || (!external && !read.has(name))) return;
        const { source, operatorCallbacks } = pipeSource(value);
        const before = found.length;
        listen(cls, source, value, operatorCallbacks);
        if (external) for (let i = before; i < found.length; i++) found[i]!.pendingMember = name;
      };
      for (const d of cls.descendantsOfType(["public_field_definition", "field_definition"])) {
        if (d && classOf(d)?.id === cls.id) consider((d.childForFieldName("name") ?? d.childForFieldName("property"))?.text, d.childForFieldName("value"));
      }
      for (const m of cls.descendantsOfType("method_definition")) {
        if (!m || classOf(m)?.id !== cls.id) continue;
        const name = m.childForFieldName("name")?.text;
        if (name === "constructor") {
          for (const as of m.descendantsOfType("assignment_expression")) {
            const left = as?.childForFieldName("left");
            if (as && left?.type === "member_expression" && left.childForFieldName("object")?.type === "this") consider(left.childForFieldName("property")?.text, as.childForFieldName("right"));
          }
        } else if (m.children.some((c) => c?.type === "get")) {
          const returns = m.descendantsOfType("return_statement");
          if (returns.length === 1) consider(name, returns[0]?.namedChildren[0]);
        }
      }
    }
  }

  if (found.length === 0) return facts;
  return { ...facts, held: holdCallbacks(facts.held, found), subjectListens: [...(facts.subjectListens ?? []), ...found] };
}

/**
 * The members a class's inline template reads through the `async` pipe (`players$ | async`): read from the `template`
 * of its decorators — on the class, or on the `export` statement around it — never from the class body. `external`:
 * the markup is in a `templateUrl` file instead, which only the project pass can read.
 */
function asyncPipeMembers(cls: Node): { members: Set<string>; external: boolean } {
  const members = new Set<string>();
  let external = false;
  const decorators = [...cls.children, ...(cls.parent?.type === "export_statement" ? cls.parent.children : [])].filter((c): c is Node => c?.type === "decorator");
  for (const d of decorators) {
    for (const pair of d.descendantsOfType("pair")) {
      const key = pair?.childForFieldName("key")?.text;
      if (key === "templateUrl") external = true;
      if (key !== "template") continue;
      const value = pair?.childForFieldName("value")?.text ?? "";
      for (const name of asyncPipedNames(value)) members.add(name);
    }
  }
  return { members, external };
}

/** The members a template pipes through `async` (`fixtures$ | async`). */
export function asyncPipedNames(template: string): string[] {
  return [...template.matchAll(/(?<![\w$.])([\w$]+)\s*\|\s*async\b/g)].map((m) => m[1]!);
}
