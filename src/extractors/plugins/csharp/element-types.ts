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
import { CSHARP_BUILTINS } from "./builtins.js";
import { bareTypeName } from "./local-types.js";

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

const set = (...names: string[]): ReadonlySet<string> => new Set(names);

const COLLECTIONS = set(
  "List", "IList", "IEnumerable", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "HashSet", "ISet", "IReadOnlySet", "Queue",
  "Stack", "Collection", "ObservableCollection", "IQueryable", "IOrderedEnumerable", "IOrderedQueryable", "ImmutableList",
  "ImmutableArray", "ImmutableHashSet", "SortedSet", "LinkedList", "IAsyncEnumerable", "ReadOnlyCollection", "ConcurrentBag",
  "ConcurrentQueue", "ConcurrentStack", "Span", "ReadOnlySpan", "Memory", "ReadOnlyMemory",
);
const MAPS = set("Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary", "ConcurrentDictionary", "ImmutableDictionary", "SortedList");

function classOf(text: string): string | null {
  const t = text.trim().replace(/\?$/, "");
  const bare = bareTypeName(t);
  if (!bare || !/^[A-Z]\w+$/.test(bare) || CSHARP_BUILTINS.has(bare)) return null;
  return t;
}

const RULES: ChainRules = {
  parseType(text) {
    const g = genericParts(text);
    if (!g) return null;
    if (g.name === "[]") return { kind: "coll", elem: g.args[0]! };
    if (COLLECTIONS.has(g.name) && g.args.length === 1) return { kind: "coll", elem: g.args[0]! };
    if (MAPS.has(g.name) && g.args.length === 2) return { kind: "map", elem: g.args[1]! };
    return null;
  },
  classOf,
  elementOf: set(
    "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "ElementAt", "ElementAtOrDefault", "Dequeue",
    "Peek", "Pop", "MinBy", "MaxBy", "Find", "FindLast",
  ),
  mapValueOf: set("GetValueOrDefault"),
  keeps: set(
    "Where", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "Distinct", "DistinctBy", "Take", "Skip", "TakeWhile",
    "SkipWhile", "Reverse", "ToList", "ToArray", "AsEnumerable", "AsQueryable", "ToHashSet", "Concat", "Union", "Except", "Intersect",
    "AsReadOnly", "ToImmutableList", "FindAll", "TakeLast", "SkipLast",
  ),
  toOptional: set(),
  optionalValue: set(),
  values: set("Values"),
  filterByType: set("OfType", "Cast"),
  indexer: true,
  callbacks: new Map<string, readonly number[]>([
    ["Where", [0]], ["Select", [0]], ["SelectMany", [0]], ["Any", [0]], ["All", [0]], ["Count", [0]], ["First", [0]],
    ["FirstOrDefault", [0]], ["Last", [0]], ["LastOrDefault", [0]], ["Single", [0]], ["SingleOrDefault", [0]], ["TakeWhile", [0]],
    ["SkipWhile", [0]], ["OrderBy", [0]], ["OrderByDescending", [0]], ["ThenBy", [0]], ["ThenByDescending", [0]], ["GroupBy", [0]],
    ["ToDictionary", [0]], ["Sum", [0]], ["Max", [0]], ["Min", [0]], ["Average", [0]], ["ForEach", [0]], ["Find", [0]],
    ["FindAll", [0]], ["Exists", [0]], ["FindIndex", [0]], ["RemoveAll", [0]], ["MaxBy", [0]], ["MinBy", [0]], ["DistinctBy", [0]],
    ["TrueForAll", [0]],
  ]),
  mapCallbacks: new Map(),
  optionalCallbacks: set(),
  valueCallbacks: set(),
};

/** The declared type text of each field and property of the type a method sits in (and its primary constructor's parameters). */
function memberTypes(method: Node): Map<string, string> {
  const out = new Map<string, string>();
  let cls: Node | null = method.parent;
  while (cls && !/^(?:class|struct|record|interface|record_struct)_declaration$/.test(cls.type)) cls = cls.parent;
  if (!cls) return out;
  for (const p of cls.children.find((c) => c.type === "parameter_list")?.namedChildren ?? []) {
    const name = p.childForFieldName("name")?.text;
    const type = p.childForFieldName("type")?.text;
    if (name && type) out.set(name, type);
  }
  const body = cls.childForFieldName("body");
  for (const m of body?.namedChildren ?? []) {
    if (m.type === "field_declaration") {
      const decl = m.namedChildren.find((c) => c.type === "variable_declaration");
      const type = decl?.childForFieldName("type")?.text;
      if (!decl || !type) continue;
      for (const d of decl.namedChildren) if (d.type === "variable_declarator") {
        const name = d.childForFieldName("name")?.text;
        if (name) out.set(name, type);
      }
    } else if (m.type === "property_declaration") {
      const name = m.childForFieldName("name")?.text;
      const type = m.childForFieldName("type")?.text;
      if (name && type) out.set(name, type);
    }
  }
  return out;
}

export interface CsharpElementFacts {
  locals: LocalType[];
  receiverOf(call: CallInfo): string | null;
}

/**
 * The bindings a C# member body makes whose type a loop, a LINQ / `ForEach` callback, a `catch` or an element
 * access states. A name bound twice to different types, or once to a type and once to something unknown, is left
 * out — a call cannot say which binding it used.
 */
export function csharpElementFacts(method: Node, body: Node, params: readonly ParamInfo[], nodes: readonly Node[]): CsharpElementFacts | null {
  const table = new Map<string, ElementState>();
  const setState = (name: string | undefined | null, type: string | null | undefined): void => {
    const s = name ? stateOfType(type, RULES) : null;
    if (name && s) table.set(name, s);
    else if (name) table.delete(name);
  };
  for (const [name, type] of memberTypes(method)) setState(name, type);
  for (const p of params) if (!p.isReceiver) setState(p.name, p.type);
  const rootState = (name: string): ElementState | undefined => table.get(name);

  const binders = new Map<string, Set<string | null>>();
  const bind = (name: string | null | undefined, type: string | null): void => {
    if (!name) return;
    const s = binders.get(name) ?? new Set<string | null>();
    s.add(type);
    binders.set(name, s);
  };

  for (const node of nodes) {
    // Nested local functions are scopes of their own.
    switch (node.type) {
      case "variable_declaration": {
        const typeNode = node.childForFieldName("type");
        const implicit = typeNode?.type === "implicit_type";
        for (const decl of node.namedChildren) {
          if (decl.type !== "variable_declarator") continue;
          const nameNode = decl.childForFieldName("name");
          const name = nameNode?.text;
          if (!name) continue;
          if (!implicit) {
            setState(name, typeNode?.text);
            continue;
          }
          const init = decl.namedChildren.find((c) => c.id !== nameNode!.id && c.type !== "bracketed_argument_list");
          const state = init ? chainState(init.text, rootState, RULES) : null;
          if (state) table.set(name, state);
          else table.delete(name);
          if (state?.kind === "value") bind(name, state.type);
        }
        break;
      }
      case "foreach_statement": {
        const typeNode = node.childForFieldName("type");
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (typeNode?.type === "implicit_type" && left?.type === "identifier") {
          bind(left.text, right ? loopElement(right.text, rootState, RULES) : null);
        }
        break;
      }
      case "catch_declaration": {
        const type = node.childForFieldName("type")?.text;
        const name = node.childForFieldName("name")?.text;
        if (type) bind(name, classOf(type));
        break;
      }
      case "lambda_expression": {
        const names: Array<{ name: string; typed: boolean }> = [];
        for (const c of node.namedChildren) {
          if (c.type === "implicit_parameter") names.push({ name: c.text, typed: false });
          else if (c.type === "parameter_list") {
            for (const p of c.namedChildren) {
              if (p.type !== "parameter") continue;
              const typed = !!p.childForFieldName("type");
              names.push({ name: p.childForFieldName("name")?.text ?? p.text, typed });
            }
          }
        }
        const argument = node.parent;
        const args = argument?.parent;
        const call = args?.parent;
        let found: ReturnType<typeof callbackElement> = null;
        if (argument?.type === "argument" && args?.type === "argument_list" && call?.type === "invocation_expression" && args.namedChildren.length === 1) {
          const fn = call.childForFieldName("function");
          if (fn?.type === "member_access_expression") {
            const nameNode = fn.childForFieldName("name");
            const method = nameNode?.type === "generic_name" ? nameNode.namedChildren.find((c) => c.type === "identifier")?.text : nameNode?.text;
            const receiver = fn.childForFieldName("expression");
            if (method && receiver) found = callbackElement(receiver.text, method, rootState, RULES);
          }
        }
        names.forEach((n, i) => {
          // A typed parameter is the existing reading's (`(IRepo r) => …`).
          if (!n.typed) bind(n.name, found && found.positions.includes(i) ? found.type : null);
        });
        break;
      }
    }
  }

  const locals: LocalType[] = [];
  for (const [name, types] of binders) {
    if (types.size !== 1) continue;
    const t = [...types][0];
    if (t) locals.push({ name, type: t });
  }
  const receiverOf = (call: CallInfo): string | null => {
    if (call.receiverType) return null;
    const split = splitCallName(call.name);
    if (!split || !/[([]/.test(split.receiver)) return null;
    return valueOfChain(split.receiver, rootState, RULES);
  };
  return locals.length > 0 || /[([]/.test(body.text) ? { locals, receiverOf } : null;
}
