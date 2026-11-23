import type { Node, Tree } from "web-tree-sitter";
import type { ScopeRegistration } from "../../../types/analysis.js";
import { enclosingFunctionNode, literalString } from "../../shared/node-helpers.js";
import { keyOf, pairsOf } from "./node-utils.js";

/**
 * AngularJS 1 (`angular.module("league").service("ClubService", function ($http) { … })`) and Alpine
 * (`Alpine.data("clubForm", clubForm)`): the facts that let a template's handler name reach the function it runs.
 *
 *   - a registered function's members are named by the registered name — `this.load = function …` in a service,
 *     `$scope.save = function …` in a controller, a returned object's `book: function …` in a factory become
 *     `ClubService.load`, `ClubCtrl.save`, `MatchApi.book` (`angularMemberName`, used by the held-function reader), so
 *     the `$http` calls in them are theirs, not the module's `<setup>`;
 *   - dependency injection by name types the injected parameters (`injectedNames`): the parameter list as written, the
 *     array annotation `['$scope', 'ClubService', function ($scope, svc) {…}]`, or `Fn.$inject = […]`; `$`-names are the
 *     framework's;
 *   - the template side: a module registering a factory under the name a template states (`scopeRegistrations`) and a
 *     route/directive binding a `templateUrl` to a controller.
 */

/** The `angular.module(…)` methods that register a function the injector calls. */
const REGISTERS: ReadonlySet<string> = new Set(["controller", "service", "factory", "provider", "directive", "component", "filter", "run", "config", "decorator"]);
/** A file with no such call registers nothing (a cheap gate before the tree walk). */
const REGISTRATION_GATE = /\.(?:module|controller|service|factory|directive)\s*\(/;
/**
 * A module another script declares (`SimpleBlogApp.controller(…)`, the variable global): these registrations count only when the
 * function takes a framework service (`$scope`, `$http`, …), which no other `controller(…)` / `service(…)` of that shape does.
 */
const GLOBAL_MODULE_KINDS: ReadonlySet<string> = new Set(["controller", "service", "factory", "directive"]);
/** Registrations whose first argument is not a name. */
const UNNAMED: ReadonlySet<string> = new Set(["run", "config"]);

interface Registration {
  /** The registered name (a controller's, a service's); null for `run`/`config`. */
  name: string | null;
  kind: string;
  /** The registered function, as written in place or the declaration an identifier names. */
  fn: Node | null;
  /** The identifier handed in (`.controller("ClubCtrl", ClubCtrl)`), if any. */
  ident: string | null;
  /** The array annotation's names, if the function is written in one. */
  annotation: string[] | null;
  line: number;
}

interface TreeFacts {
  registrations: Registration[];
  /** Function node id → its registration. */
  byFunction: Map<number, Registration>;
  /** `Fn.$inject = [...]`: the first array assigned, by the function's name. */
  injectArrays: Map<string, string[]>;
  /** What `angularMember` decided for a function node id. */
  members: Map<number, AngularMember | null>;
  /** The names a registered function's body binds to `this` or a fresh object, by function node id. */
  owners: Map<number, Set<string>>;
}

interface AngularMember {
  owner: string;
  member: string;
  host: Node;
}

/** The facts of each tree, read once; the map lets a freed tree go. */
const memos = new WeakMap<Tree, TreeFacts>();

const FUNCTIONS: ReadonlySet<string> = new Set(["function_expression", "arrow_function", "function_declaration", "function"]);

/** Names bound to a module: `var app = angular.module("league", [])`. */
function moduleVariables(tree: Tree): Set<string> {
  const out = new Set<string>();
  for (const d of tree.rootNode.descendantsOfType(["variable_declarator", "assignment_expression"])) {
    if (!d) continue;
    const name = d.childForFieldName(d.type === "variable_declarator" ? "name" : "left");
    const value = d.childForFieldName(d.type === "variable_declarator" ? "value" : "right");
    if (name?.type !== "identifier" || value?.type !== "call_expression") continue;
    const callee = value.childForFieldName("function");
    if (callee?.type === "member_expression" && callee.text.replace(/\s+/g, "") === "angular.module") out.add(name.text);
  }
  return out;
}

/** Whether a call's callee chain starts at `angular.module(…)`, or at a variable bound to one. */
function rootedAtAngularModule(callee: Node, variables: ReadonlySet<string>): boolean {
  let n: Node | null = callee;
  let sawModule = false;
  for (let i = 0; n && i < 40; i++) {
    if (n.type === "member_expression") {
      const prop = n.childForFieldName("property")?.text;
      if (prop === "module" && n.childForFieldName("object")?.text === "angular") return true;
      n = n.childForFieldName("object");
    } else if (n.type === "call_expression") {
      n = n.childForFieldName("function");
    } else {
      return n.type === "identifier" && (variables.has(n.text) || (sawModule && n.text === "angular"));
    }
    sawModule = true;
  }
  return false;
}

/** The named children of a node, comments left out. */
function nonComments(n: Node | null | undefined): Node[] {
  return n?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
}

/** A function's parameter list (a lone arrow parameter has its own field). */
function paramsOf(fn: Node): Node | null {
  return fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
}

/** The first function declaration of each name in the tree. */
function declaredFunctions(root: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const d of root.descendantsOfType("function_declaration")) {
    const name = d?.childForFieldName("name")?.text;
    if (d && name && !out.has(name)) out.set(name, d);
  }
  return out;
}

/** `ClubCtrl.$inject = ["$scope", "ClubService"]`: the annotation of a declared function, the first array of each name. */
function injectArraysOf(root: Node): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of root.descendantsOfType("assignment_expression")) {
    const left = a?.childForFieldName("left");
    if (left?.type !== "member_expression") continue;
    const text = left.text.replace(/\s+/g, "");
    if (!text.endsWith(".$inject")) continue;
    const name = text.slice(0, -".$inject".length);
    const right = a!.childForFieldName("right");
    if (right?.type !== "array" || out.has(name)) continue;
    out.set(name, nonComments(right).map((x) => literalString(x) ?? ""));
  }
  return out;
}

/** Read a tree's facts from the source text the extractor has (a later `factsOf` finds them memoised). */
export function readAngularFacts(tree: Tree, sourceText: string): void {
  factsOf(tree, sourceText);
}

function factsOf(tree: Tree, sourceText?: string): TreeFacts {
  const known = memos.get(tree);
  if (known) return known;
  const registrations: Registration[] = [];
  const byFunction = new Map<number, Registration>();
  const text = sourceText ?? tree.rootNode.text;
  const memo: TreeFacts = { registrations, byFunction, injectArrays: text.includes("$inject") ? injectArraysOf(tree.rootNode) : new Map(), members: new Map(), owners: new Map() };
  memos.set(tree, memo);
  // The cheap gate: a file with no such call registers nothing.
  if (!REGISTRATION_GATE.test(text)) return memo;
  let declared: Map<string, Node> | null = null;
  const variables = moduleVariables(tree);
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = call?.childForFieldName("function");
    if (!call || callee?.type !== "member_expression") continue;
    const kind = callee.childForFieldName("property")?.text ?? "";
    if (!REGISTERS.has(kind)) continue;
    const receiver = callee.childForFieldName("object")!;
    const rooted = rootedAtAngularModule(receiver, variables);
    if (!rooted && !(receiver.type === "identifier" && GLOBAL_MODULE_KINDS.has(kind))) continue;
    const args = nonComments(call.childForFieldName("arguments"));
    const name = UNNAMED.has(kind) ? null : literalString(args[0]);
    if (!UNNAMED.has(kind) && !name) continue;
    const value = args[UNNAMED.has(kind) ? 0 : 1];
    if (!value) continue;
    let fn: Node | null = null;
    let ident: string | null = null;
    let annotation: string[] | null = null;
    let target: Node | null = value;
    if (value.type === "array") {
      const items = nonComments(value);
      annotation = items.slice(0, -1).map((a) => literalString(a) ?? "");
      target = items[items.length - 1] ?? null;
    }
    if (target && FUNCTIONS.has(target.type)) fn = target;
    else if (target?.type === "identifier") {
      ident = target.text;
      fn = (declared ??= declaredFunctions(tree.rootNode)).get(ident) ?? null;
    }
    if (!rooted) {
      const params = fn ? paramsOf(fn) : null;
      const names = [...(annotation ?? []), ...(params ? [params.text] : [])];
      if (!names.some((n) => /(?:^|[^\w$])\$[A-Za-z]/.test(n))) continue;
    }
    const reg: Registration = { name, kind, fn, ident, annotation, line: call.startPosition.row + 1 };
    registrations.push(reg);
    if (fn) byFunction.set(fn.id, reg);
  }
  return memo;
}

/** The names a function's parameters are injected by, in order, or null when the function is not one the injector calls. */
function injectedNames(fn: Node): string[] | null {
  if (!FUNCTIONS.has(fn.type)) return null;
  const facts = factsOf(fn.tree);
  const reg = facts.byFunction.get(fn.id);
  const own = (): string[] => {
    const params = paramsOf(fn);
    if (!params) return [];
    return params.type === "identifier" ? [params.text] : params.namedChildren.filter((p): p is Node => !!p && p.type === "identifier").map((p) => p.text);
  };
  if (fn.type === "function_declaration") {
    const name = fn.childForFieldName("name")?.text;
    if (!name) return null;
    const inject = facts.injectArrays.get(name);
    if (inject) return inject;
    return reg ? own() : null;
  }
  if (!reg) return null;
  return reg.annotation ?? own();
}

/** The type an injected parameter has: the name it is injected by, unless it is the framework's own (`$scope`, `$http`). */
export function injectedTypes(fn: Node, paramNames: readonly string[]): Map<string, string> | null {
  const names = injectedNames(fn);
  if (!names) return null;
  const out = new Map<string, string>();
  paramNames.forEach((p, i) => {
    const injected = names[i];
    if (injected && /^[A-Za-z_][\w]*$/.test(injected)) out.set(p, injected);
  });
  return out.size > 0 ? out : null;
}

/** Names bound inside `fn` to `this` or to a fresh object (`var vm = this`, `var service = {}`). */
function ownersIn(fn: Node, facts: TreeFacts): Set<string> {
  const known = facts.owners.get(fn.id);
  if (known) return known;
  const out = new Set<string>(["this", "$scope"]);
  facts.owners.set(fn.id, out);
  const body = fn.childForFieldName("body");
  if (!body) return out;
  for (const d of body.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    const value = d?.childForFieldName("value");
    if (name?.type !== "identifier" || !value) continue;
    if (value.type === "this" || (value.type === "object" && value.namedChildCount === 0)) out.add(name.text);
  }
  return out;
}

/**
 * The name a function written in place inside a registered function takes: `ClubService.load` for
 * `this.load = function …` (or `$scope.load`, an alias of `this`, a local `{}` the factory returns) directly in the
 * registered function's body, and for `load: function …` of the object the registered function returns. Null for
 * every other function.
 */
export function angularMemberName(fn: Node): string | null {
  const m = angularMember(fn);
  return m ? `${m.owner}.${m.member}` : null;
}

/** The registered function a member belongs to: its registered name, the member's name and the function's span. */
export function angularMember(fn: Node): AngularMember | null {
  const parent = fn.parent;
  if (!parent) return null;
  const facts = factsOf(fn.tree);
  if (facts.registrations.length === 0) return null;
  if (facts.members.has(fn.id)) return facts.members.get(fn.id) ?? null;
  const found = memberOf(fn, parent, facts);
  facts.members.set(fn.id, found);
  return found;
}

function memberOf(fn: Node, parent: Node, facts: TreeFacts): AngularMember | null {
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === fn.id) {
    const left = parent.childForFieldName("left");
    if (left?.type !== "member_expression") return null;
    const owner = left.childForFieldName("object")?.text;
    const member = left.childForFieldName("property")?.text;
    const host = enclosingFunctionNode(parent);
    const reg = host ? facts.byFunction.get(host.id) : undefined;
    if (!host || !reg?.name || !IDENT.test(reg.name) || !owner || !member || !IDENT.test(member) || !ownersIn(host, facts).has(owner)) return null;
    return { owner: reg.name, member, host };
  }
  if (parent.type === "pair") {
    const obj = parent.parent;
    const ret = obj?.parent;
    if (obj?.type !== "object" || ret?.type !== "return_statement") return null;
    const host = enclosingFunctionNode(ret);
    const reg = host ? facts.byFunction.get(host.id) : undefined;
    const key = keyOf(parent);
    if (!host || !reg?.name || !IDENT.test(reg.name) || !key || !IDENT.test(key)) return null;
    return { owner: reg.name, member: key, host };
  }
  return null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * The registrations the template side joins on: an Alpine `Alpine.data("clubForm", clubForm)`, an AngularJS
 * `.controller("ClubCtrl", ClubCtrl)` handed a named function, and a route or directive object binding
 * `templateUrl` to a `controller` name.
 */
export function extractScopeRegistrations(tree: Tree, sourceText: string): ScopeRegistration[] {
  const out: ScopeRegistration[] = [];
  if (sourceText.includes("Alpine.data(")) {
    for (const call of tree.rootNode.descendantsOfType("call_expression")) {
      const callee = call?.childForFieldName("function");
      if (!call || callee?.type !== "member_expression" || callee.text !== "Alpine.data") continue;
      const args = nonComments(call.childForFieldName("arguments"));
      const name = literalString(args[0]);
      if (!name) continue;
      out.push({ kind: "component", name, ...(args[1]?.type === "identifier" ? { value: args[1].text } : {}), line: call.startPosition.row + 1 });
    }
  }
  if (!sourceText.includes("controller")) return out;
  for (const reg of factsOf(tree, sourceText).registrations) {
    if (reg.kind === "controller" && reg.name && reg.ident) out.push({ kind: "component", name: reg.name, value: reg.ident, line: reg.line });
  }
  if (sourceText.includes("templateUrl")) {
    for (const obj of tree.rootNode.descendantsOfType("object")) {
      if (!obj) continue;
      const pairs = pairsOf(obj);
      const template = literalString(pairs.get("templateUrl"));
      const controller = literalString(pairs.get("controller"));
      const name = controller?.split(/\s+as\s+/)[0]?.trim();
      if (template && name) out.push({ kind: "template", name: template, value: name, line: obj.startPosition.row + 1 });
    }
  }
  return out;
}
