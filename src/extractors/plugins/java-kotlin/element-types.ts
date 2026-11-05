import type { Node } from "web-tree-sitter";
import type { CallInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import {
  type ChainRules,
  type ElementState,
  callbackElement,
  chainState,
  genericParts,
  loopElement,
  splitCallName,
  stateOfType,
  valueOfChain,
} from "../shared/element-chain.js";

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];
type JkLang = "java" | "kotlin";

const set = (...names: string[]): ReadonlySet<string> => new Set(names);

/** Types that say nothing about a receiver's own members. */
const NOT_CLASSES = set(
  "String", "Integer", "Long", "Double", "Float", "Boolean", "Short", "Byte", "Character", "Object", "Number", "Void",
  "Any", "Int", "Unit", "Nothing", "CharSequence", "Char", "Comparable", "Class", "Date", "UUID", "BigDecimal", "BigInteger",
);

function classOf(text: string): string | null {
  const g = genericParts(text);
  if (!g || g.name === "[]") return null;
  if (!/^[A-Z]\w+$/.test(g.name) || NOT_CLASSES.has(g.name)) return null;
  return text.trim().replace(/\?$/, "").replace(/^(?:final|out|in)\s+/, "").replace(/^\?\s*(?:extends|super)\s+/, "");
}

const JAVA_COLLECTIONS = set(
  "List", "ArrayList", "LinkedList", "Collection", "Set", "HashSet", "LinkedHashSet", "TreeSet", "SortedSet", "NavigableSet",
  "Iterable", "Iterator", "ListIterator", "Deque", "ArrayDeque", "Queue", "Stack", "Vector", "Stream", "Flux",
  "CopyOnWriteArrayList", "PriorityQueue", "BlockingQueue",
);
const KOTLIN_COLLECTIONS = set(
  "List", "MutableList", "ArrayList", "LinkedList", "Collection", "MutableCollection", "Set", "MutableSet", "HashSet",
  "LinkedHashSet", "TreeSet", "SortedSet", "Iterable", "MutableIterable", "Iterator", "Sequence", "Array", "ArrayDeque",
  "Deque", "Stack", "Flow", "Stream", "Queue",
);
const MAPS = set(
  "Map", "HashMap", "TreeMap", "LinkedHashMap", "SortedMap", "NavigableMap", "ConcurrentMap", "ConcurrentHashMap", "MutableMap",
);
const OPTIONALS = set("Optional", "Mono");

function parseType(language: JkLang): ChainRules["parseType"] {
  const collections = language === "java" ? JAVA_COLLECTIONS : KOTLIN_COLLECTIONS;
  return (text) => {
    const g = genericParts(text);
    if (!g) return null;
    if (g.name === "[]") return { kind: "coll", elem: g.args[0]! };
    if (collections.has(g.name) && g.args.length === 1) return { kind: "coll", elem: g.args[0]! };
    if (MAPS.has(g.name) && g.args.length === 2) return { kind: "map", elem: g.args[1]! };
    if (OPTIONALS.has(g.name) && g.args.length === 1) return { kind: "optional", elem: g.args[0]! };
    return null;
  };
}

const JAVA_RULES: ChainRules = {
  parseType: parseType("java"),
  classOf,
  elementOf: set("get", "getFirst", "getLast", "removeFirst", "removeLast", "peek", "poll", "pop", "first", "last", "element", "next", "peekFirst", "peekLast", "pollFirst", "pollLast"),
  mapValueOf: set("get", "getOrDefault", "computeIfAbsent"),
  keeps: set("stream", "parallelStream", "filter", "sorted", "distinct", "limit", "skip", "peek", "toList", "reversed", "subList", "takeWhile", "dropWhile", "iterator", "listIterator"),
  toOptional: set("findFirst", "findAny", "min", "max"),
  optionalValue: set("get", "orElseThrow", "orElse", "orElseGet", "block"),
  values: set("values"),
  filterByType: set(),
  indexer: true,
  callbacks: new Map<string, readonly number[]>([
    ["forEach", [0]], ["filter", [0]], ["map", [0]], ["flatMap", [0]], ["anyMatch", [0]], ["allMatch", [0]], ["noneMatch", [0]],
    ["peek", [0]], ["removeIf", [0]], ["takeWhile", [0]], ["dropWhile", [0]], ["mapToInt", [0]], ["mapToLong", [0]],
    ["mapToDouble", [0]], ["forEachOrdered", [0]], ["sorted", [0, 1]], ["max", [0, 1]], ["min", [0, 1]], ["doOnNext", [0]],
  ]),
  mapCallbacks: new Map<string, readonly number[]>([["forEach", [1]], ["computeIfPresent", [1]], ["replaceAll", [1]]]),
  optionalCallbacks: set("ifPresent", "ifPresentOrElse", "map", "filter", "flatMap"),
  valueCallbacks: set(),
};

const KOTLIN_RULES: ChainRules = {
  parseType: parseType("kotlin"),
  classOf,
  elementOf: set(
    "first", "last", "firstOrNull", "lastOrNull", "single", "singleOrNull", "elementAt", "elementAtOrNull", "get", "getOrNull",
    "random", "randomOrNull", "removeFirst", "removeLast", "removeAt", "find", "findLast", "maxByOrNull", "minByOrNull", "maxBy",
    "minBy", "poll", "peek", "pop", "getFirst", "getLast", "next",
  ),
  mapValueOf: set("get", "getValue", "getOrDefault", "getOrElse", "getOrPut", "remove"),
  keeps: set(
    "filter", "filterNot", "filterNotNull", "sorted", "sortedBy", "sortedByDescending", "sortedDescending", "sortedWith", "distinct",
    "distinctBy", "take", "drop", "takeLast", "dropLast", "takeWhile", "dropWhile", "reversed", "asReversed", "toList",
    "toMutableList", "toSet", "toMutableSet", "asSequence", "asIterable", "onEach", "shuffled", "plus", "minus", "subList",
    "filterIndexed", "iterator", "stream", "toTypedArray",
  ),
  toOptional: set(),
  optionalValue: set("get", "orElseThrow", "orElse", "orElseGet", "block"),
  values: set("values"),
  filterByType: set("filterIsInstance"),
  indexer: true,
  callbacks: new Map<string, readonly number[]>([
    ["forEach", [0]], ["map", [0]], ["mapNotNull", [0]], ["filter", [0]], ["filterNot", [0]], ["any", [0]], ["all", [0]],
    ["none", [0]], ["count", [0]], ["find", [0]], ["findLast", [0]], ["first", [0]], ["last", [0]], ["firstOrNull", [0]],
    ["lastOrNull", [0]], ["single", [0]], ["singleOrNull", [0]], ["sumOf", [0]], ["sumBy", [0]], ["maxBy", [0]], ["minBy", [0]],
    ["maxByOrNull", [0]], ["minByOrNull", [0]], ["sortedBy", [0]], ["sortedByDescending", [0]], ["groupBy", [0]],
    ["associateBy", [0]], ["associate", [0]], ["flatMap", [0]], ["takeWhile", [0]], ["dropWhile", [0]], ["partition", [0]],
    ["onEach", [0]], ["distinctBy", [0]], ["removeIf", [0]], ["forEachIndexed", [1]], ["mapIndexed", [1]], ["filterIndexed", [1]],
    ["onEachIndexed", [1]], ["sortedWith", [0, 1]],
  ]),
  mapCallbacks: new Map<string, readonly number[]>([["forEach", [1]]]),
  optionalCallbacks: set("ifPresent", "map", "filter", "flatMap"),
  valueCallbacks: set("let", "also", "takeIf", "takeUnless"),
};

export const jvmRules = (language: JkLang): ChainRules => (language === "java" ? JAVA_RULES : KOTLIN_RULES);

/** The declared type text of each field / property of the class a method sits in. */
function memberTypes(method: Node, language: JkLang): Map<string, string> {
  const out = new Map<string, string>();
  let cls: Node | null = method.parent;
  while (cls && cls.type !== "class_declaration" && cls.type !== "enum_declaration" && cls.type !== "object_declaration" && cls.type !== "record_declaration" && cls.type !== "interface_declaration") cls = cls.parent;
  if (!cls) return out;
  if (language === "java") {
    const body = cls.childForFieldName("body");
    for (const m of body?.namedChildren ?? []) {
      if (m.type !== "field_declaration") continue;
      const type = m.childForFieldName("type")?.text;
      if (!type) continue;
      for (const d of m.namedChildren) if (d.type === "variable_declarator") {
        const name = d.childForFieldName("name")?.text;
        if (name) out.set(name, type);
      }
    }
    for (const p of cls.childForFieldName("parameters")?.namedChildren ?? []) {
      const name = p.childForFieldName("name")?.text;
      const type = p.childForFieldName("type")?.text;
      if (name && type) out.set(name, type);
    }
    return out;
  }
  for (const c of cls.children) {
    if (c.type === "primary_constructor") {
      for (const p of c.namedChildren) {
        if (p.type !== "class_parameter") continue;
        const name = p.children.find((x) => x.type === "simple_identifier")?.text;
        const type = p.children.find((x) => x.type === "user_type" || x.type === "nullable_type")?.text;
        if (name && type) out.set(name, type);
      }
    } else if (c.type === "class_body") {
      for (const m of c.namedChildren) {
        if (m.type !== "property_declaration") continue;
        const holder = m.children.find((x) => x.type === "variable_declaration");
        const name = holder?.children.find((x) => x.type === "simple_identifier")?.text;
        const type = holder?.children.find((x) => x.type === "user_type" || x.type === "nullable_type")?.text;
        if (name && type) out.set(name, type);
      }
    }
  }
  return out;
}

export interface ElementFacts {
  /** Locals the body binds by an element type, a narrowing, a catch or a typed lambda parameter. */
  locals: LocalType[];
  /** Types the receiver of a call stated as an element access names (`cars.get(0).wash()` → `Car`). */
  receiverOf(call: CallInfo): string | null;
}

/**
 * The bindings a method body makes whose type a loop, a callback, a narrowing, a `catch` or an element access
 * states — see `extractLocalTypes`. A name bound twice to different types (or once to a type and once to
 * something unknown) is dropped: a call cannot say which binding it used.
 */
export function jvmElementFacts(
  method: Node,
  body: Node,
  language: JkLang,
  params: readonly ParamInfo[],
): ElementFacts | null {
  const rules = jvmRules(language);
  const table = new Map<string, ElementState>();
  const setState = (name: string | undefined | null, type: string | null | undefined): void => {
    const s = name ? stateOfType(type, rules) : null;
    if (name && s) table.set(name, s);
    else if (name) table.delete(name);
  };
  for (const [name, type] of memberTypes(method, language)) setState(name, type);
  for (const p of params) if (!p.isReceiver) setState(p.name, p.type);
  const rootState = (name: string): ElementState | undefined => table.get(name);

  const binders = new Map<string, Set<string | null>>();
  const bind = (name: string | null | undefined, type: string | null): void => {
    if (!name) return;
    const set = binders.get(name) ?? new Set<string | null>();
    set.add(type);
    binders.set(name, set);
  };
  const bindChain = (name: string | null | undefined, init: Node | null | undefined): void => {
    if (!name) return;
    const state = init ? chainState(init.text, rootState, rules) : null;
    if (state) table.set(name, state);
    else table.delete(name);
    if (state?.kind === "value") bind(name, state.type);
  };

  // Kotlin `is` narrowing: the name keeps its declared type outside the regions that test it, so it is typed only
  // when every receiver use of it sits inside such regions, all of one type.
  const narrowed = new Map<string, Array<{ type: string; region: Node }>>();

  const lambdaNames = (lambda: Node): Array<{ name: string; type: string | null }> => {
    const out: Array<{ name: string; type: string | null }> = [];
    if (language === "java") {
      const ps = lambda.childForFieldName("parameters");
      if (!ps) return out;
      if (ps.type === "identifier") out.push({ name: ps.text, type: null });
      else for (const p of ps.namedChildren) {
        if (p.type === "identifier") out.push({ name: p.text, type: null });
        else if (p.type === "formal_parameter") {
          const t = p.childForFieldName("type")?.text;
          out.push({ name: p.childForFieldName("name")?.text ?? "", type: t && t !== "var" ? classOf(t) : null });
        }
      }
      return out;
    }
    const ps = lambda.namedChildren.find((c) => c.type === "lambda_parameters");
    if (!ps) return [{ name: "it", type: null }];
    for (const p of ps.namedChildren) {
      if (p.type === "variable_declaration") {
        const t = p.children.find((x) => x.type === "user_type" || x.type === "nullable_type")?.text;
        out.push({ name: p.children.find((x) => x.type === "simple_identifier")?.text ?? "", type: t ? classOf(t) : null });
      } else if (p.type === "multi_variable_declaration") {
        for (const v of p.namedChildren) out.push({ name: v.children.find((x) => x.type === "simple_identifier")?.text ?? "", type: null });
      }
    }
    return out;
  };

  /** The receiver text and method a lambda is handed to, null when it is not a plain argument. */
  const lambdaCallee = (lambda: Node): { receiver: string; method: string } | null => {
    if (language === "java") {
      const args = lambda.parent;
      const call = args?.parent;
      if (args?.type !== "argument_list" || call?.type !== "method_invocation" || args.namedChildren.length !== 1) return null;
      const object = call.childForFieldName("object");
      const name = call.childForFieldName("name")?.text;
      return object && name ? { receiver: object.text, method: name } : null;
    }
    const call = lambda.parent?.type === "annotated_lambda" ? lambda.parent.parent?.parent : null;
    if (call?.type !== "call_expression") return null;
    const callee = call.child(0);
    if (callee?.type !== "navigation_expression") return null;
    const last = callee.namedChildren[callee.namedChildCount - 1];
    const method = last?.type === "navigation_suffix" ? last.namedChildren.find((c) => c.type === "simple_identifier")?.text : undefined;
    const receiver = callee.child(0);
    return receiver && method ? { receiver: receiver.text, method } : null;
  };

  const bindLambda = (lambda: Node): void => {
    const names = lambdaNames(lambda);
    const callee = lambdaCallee(lambda);
    const found = callee ? callbackElement(callee.receiver, callee.method, rootState, rules) : null;
    names.forEach((n, i) => {
      if (n.type) bind(n.name, n.type);
      else bind(n.name, found && found.positions.includes(i) ? found.type : null);
    });
  };

  const regionOf = (check: Node): Node | null => {
    // `if (o is Car) { … }` / `if (a && o is Car) { … }`: the consequence.
    let cond: Node = check;
    while (cond.parent && cond.parent.type === "conjunction_expression") cond = cond.parent;
    const parent = cond.parent;
    if (parent?.type === "if_expression") {
      const body = parent.namedChildren.find((c) => c.type === "control_structure_body");
      return body && body.startIndex > cond.startIndex ? body : null;
    }
    return null;
  };

  const visit = (n: Node): void => {
    switch (n.type) {
      case "local_variable_declaration": {
        const type = n.childForFieldName("type")?.text;
        for (const d of n.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const name = d.childForFieldName("name")?.text;
          if (type && type !== "var") setState(name, type);
          else bindChain(name, d.childForFieldName("value"));
        }
        break;
      }
      case "enhanced_for_statement": {
        const type = n.childForFieldName("type")?.text;
        const name = n.childForFieldName("name")?.text;
        const iterable = n.childForFieldName("value");
        if (type === "var") bind(name, iterable ? loopElement(iterable.text, rootState, rules) : null);
        break;
      }
      case "lambda_expression":
      case "lambda_literal":
        bindLambda(n);
        break;
      case "instanceof_expression": {
        const named = n.namedChildren;
        if (named.length === 3) bind(named[2]!.text, classOf(named[1]!.text));
        break;
      }
      case "type_pattern": {
        const named = n.namedChildren;
        if (named.length === 2) bind(named[1]!.text, classOf(named[0]!.text));
        break;
      }
      case "catch_formal_parameter": {
        const types = n.namedChildren.find((c) => c.type === "catch_type")?.namedChildren ?? [];
        bind(n.childForFieldName("name")?.text, types.length === 1 ? classOf(types[0]!.text) : null);
        break;
      }
      case "resource": {
        const type = n.childForFieldName("type")?.text;
        const name = n.childForFieldName("name")?.text;
        if (name && type && type !== "var") bind(name, classOf(type));
        break;
      }
      // Kotlin.
      case "property_declaration": {
        if (language !== "kotlin") break;
        const holder = n.children.find((c) => c.type === "variable_declaration");
        const name = holder?.children.find((c) => c.type === "simple_identifier")?.text;
        const type = holder?.children.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text;
        const eq = n.children.findIndex((c) => c.type === "=");
        const init = eq >= 0 ? n.children[eq + 1] : n.namedChildren[n.namedChildren.length - 1]?.type === "variable_declaration" ? null : n.namedChildren[n.namedChildren.length - 1];
        if (type) setState(name, type);
        else if (init && init !== holder) bindChain(name, init);
        break;
      }
      case "for_statement": {
        if (language !== "kotlin") break;
        const decl = n.namedChildren.find((c) => c.type === "variable_declaration" || c.type === "multi_variable_declaration");
        const iterable = decl ? n.namedChildren[n.namedChildren.indexOf(decl) + 1] : null;
        if (!decl) break;
        const nameOf = (v: Node): string | undefined => v.children.find((x) => x.type === "simple_identifier")?.text;
        if (decl.type === "variable_declaration") {
          const t = decl.children.find((x) => x.type === "user_type" || x.type === "nullable_type")?.text;
          bind(nameOf(decl), t ? classOf(t) : iterable ? loopElement(iterable.text, rootState, rules) : null);
        } else {
          const vars = decl.namedChildren;
          const state = iterable ? chainState(iterable.text, rootState, rules) : null;
          vars.forEach((v, i) => bind(nameOf(v), state?.kind === "map" && vars.length === 2 && i === 1 ? rules.classOf(state.elem) : null));
        }
        break;
      }
      case "catch_block": {
        if (language !== "kotlin") break;
        const name = n.children.find((c) => c.type === "simple_identifier")?.text;
        const type = n.children.find((c) => c.type === "user_type")?.text;
        bind(name, type ? classOf(type) : null);
        break;
      }
      case "check_expression": {
        if (language !== "kotlin" || n.children.some((c) => c.type === "!is")) break;
        const subject = n.namedChildren[0];
        const type = n.namedChildren.find((c) => c.type === "user_type")?.text;
        const cls = type ? classOf(type) : null;
        const region = regionOf(n);
        if (subject?.type === "simple_identifier" && cls && region) {
          const list = narrowed.get(subject.text) ?? [];
          list.push({ type: cls, region });
          narrowed.set(subject.text, list);
        }
        break;
      }
      case "when_entry": {
        if (language !== "kotlin") break;
        const test = n.namedChildren.find((c) => c.type === "when_condition")?.namedChildren.find((c) => c.type === "type_test");
        const subject = n.parent?.namedChildren.find((c) => c.type === "when_subject")?.namedChildren[0];
        const type = test?.namedChildren.find((c) => c.type === "user_type")?.text;
        const cls = type ? classOf(type) : null;
        const region = n.namedChildren.find((c) => c.type === "control_structure_body");
        if (test && !test.children.some((c) => c.type === "!is") && subject?.type === "simple_identifier" && cls && region) {
          const list = narrowed.get(subject.text) ?? [];
          list.push({ type: cls, region });
          narrowed.set(subject.text, list);
        }
        break;
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(body);

  // A name narrowed by `is`: typed when no receiver use of it lies outside the narrowing regions.
  for (const [name, regions] of narrowed) {
    const types = new Set(regions.map((r) => r.type));
    if (types.size !== 1 || binders.has(name)) continue;
    let leaks = false;
    const scan = (n: Node): void => {
      if (leaks) return;
      if (n.type === "navigation_expression" && n.child(0)?.type === "simple_identifier" && n.child(0)!.text === name) {
        const at = n.startIndex;
        if (!regions.some((r) => at >= r.region.startIndex && at < r.region.endIndex)) leaks = true;
      }
      for (const c of n.children) scan(c);
    };
    scan(body);
    if (!leaks) bind(name, [...types][0]!);
  }

  const locals: LocalType[] = [];
  for (const [name, types] of binders) {
    if (types.size === 1) {
      const t = [...types][0];
      if (t) locals.push({ name, type: t });
    }
  }
  const receiverOf = (call: CallInfo): string | null => {
    if (call.receiverType) return null;
    const split = splitCallName(call.name);
    if (!split || !/[([]/.test(split.receiver)) return null;
    return valueOfChain(split.receiver, rootState, rules);
  };
  return locals.length > 0 || /[([]/.test(body.text) ? { locals, receiverOf } : null;
}
