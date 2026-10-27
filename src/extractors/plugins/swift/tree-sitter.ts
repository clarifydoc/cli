import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { getGrammarParser, type TSNode } from "../../../parsers/parser-manager.js";
import { normalizeSource } from "../../../parsers/normalize-source.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { swiftDiCallPatterns } from "./di.js";

/**
 * How many calls deep a chain is named. The Swift spec has no chain patterns — the baseline skips a method on a
 * call's result — but the linker types a chain step by step through declared return types, and builder chains
 * (`URLSession.shared.dataTask(with: r).resume()`, SwiftUI modifiers) run long.
 */
const CHAIN_DEPTH = 8;

/** Declarations that are functions as the Swift spec's patterns read them: `func name`, `init`. */
const FUNCTIONS: ReadonlySet<string> = new Set(["function_declaration", "protocol_function_declaration", "init_declaration"]);

/** Type declarations: what their bodies call outside a method is no function's. */
const TYPES: ReadonlySet<string> = new Set(["class_declaration", "protocol_declaration"]);

/** Lower-case words that open a block (`if x {`, `get {`): never a trailing-closure call, as the spec's pattern reads them. */
const NOT_A_CALL: ReadonlySet<string> = new Set(
  "if guard else do catch defer switch repeat while for in get set willSet didSet init deinit subscript func var let return throw try await".split(" "),
);

/**
 * The Swift front end of the `tree-sitter:swift` feature: tree-sitter-swift's reading of a file's functions and
 * calls, loaded on first use (the grammar is the wasm `npm run setup` builds).
 */
export async function loadSwiftReader(): Promise<(source: string) => ParsedStructure> {
  const parser = await getGrammarParser("swift");
  return (source) => {
    const text = normalizeSource(source);
    const tree = parser.parse(text);
    if (!tree) throw new Error("tree-sitter-swift returned no tree");
    try {
      return readSwiftTree(tree.rootNode, text);
    } finally {
      tree.delete();
    }
  };
}

/**
 * Swift's functions and calls from a tree-sitter-swift tree. A function is a `func` (free, a method, a protocol
 * requirement, nested) or an `init`, spanning its keyword's line to its body's `}`, and owns the calls in its
 * body except those of a function declared inside it; a closure's calls are its owner's. An accessor, `deinit`
 * or a type's member initializer is no function, as the patterns read them. A call is named as the Swift
 * spec's patterns name it: a path is its last two names (`self.repo.find(` is `repo.find`, `obj?.load(` is
 * `obj.load`), a call with only a trailing closure its whole path (`DispatchQueue.main.async {`, never a
 * construction like `VStack {`), and a container lookup what `swiftDiCallPatterns` names. Where the patterns
 * name nothing the parser can still name: a method on a call's result is the chain from its first call
 * (`repo.find(id).first(` is `repo.find().first`), one on a construction is the type's (`Club(id: 1).save(` is
 * `Club.save` on `Club`), a generic type's construction is its name (`Cache<String, Club>(`), and calls inside
 * string interpolation are calls. A subscript (`items[0]`) and a macro's name (`#expect(`) are none.
 */
export function readSwiftTree(root: TSNode, text: string): ParsedStructure {
  const functions: Array<{ span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] }> = [];
  const topLevel: PatternCallName[] = [];
  const stack: Array<{ node: TSNode; calls: PatternCallName[] | null }> = [{ node: root, calls: topLevel }];
  while (stack.length > 0) {
    const { node, calls: owner } = stack.pop()!;
    let calls = owner;
    const type = node.type;
    if (FUNCTIONS.has(type)) {
      const name = functionName(node);
      calls = [];
      if (name) {
        const keyword = keywordRow(node, type === "init_declaration" ? "init" : "func");
        functions.push({ span: { name, line: keyword + 1, endLine: node.endPosition.row + 1 }, calls });
      }
    } else if (TYPES.has(type) && owner === topLevel) {
      calls = null;
    } else if (type === "call_expression" && owner) {
      const named = callName(node, text);
      if (named) owner.push(named);
    } else if (type === "constructor_expression" && owner) {
      const named = constructorName(node);
      if (named) owner.push(named);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push({ node: node.namedChild(i)!, calls });
  }
  functions.sort((a, b) => a.span.line - b.span.line);
  return {
    functions: functions.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) })),
    topLevelCalls: recordPatternCalls(topLevel),
    syntaxErrors: countErrors(root),
  };
}

/** `func name`'s name, `init` for an initializer; null for an operator (`func ==`), which no pattern reads. */
function functionName(node: TSNode): string | null {
  if (node.type === "init_declaration") return "init";
  const name = node.childForFieldName("name")?.text ?? "";
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}

/** The 0-based row of the declaration's keyword, after any attributes and modifiers above it. */
function keywordRow(node: TSNode, keyword: string): number {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === keyword) return child.startPosition.row;
  }
  return (node.childForFieldName("name") ?? node).startPosition.row;
}

function countErrors(root: TSNode): number {
  if (!root.hasError) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      count++;
      continue;
    }
    if (!node.hasError) continue;
    for (let i = 0; i < node.childCount; i++) stack.push(node.child(i)!);
  }
  // A node can carry the flag with no error node under it; the file still did not parse cleanly.
  return Math.max(count, 1);
}

/** One step of a callee, left to right. */
type Segment =
  | { kind: "id"; name: string; node: TSNode }
  | { kind: "call"; constructs?: string }
  /** `literal`: `"s".f(`, a tuple field `x.0.f(` — the patterns read the bare method; anything else names none. */
  | { kind: "other"; bare: boolean };

const call = (name: string, leafName: string, at: TSNode, receiverType?: string): PatternCallName => ({
  name,
  leafName,
  line: at.startPosition.row + 1,
  column: at.startPosition.column,
  ...(receiverType ? { receiverType } : {}),
});

/** A call's argument list: `value_arguments` in `(…)` (a `[…]` one is a subscript), and whether a closure trails. */
function suffixOf(node: TSNode): { args: TSNode | null; subscript: boolean; trailing: boolean } | null {
  const suffix = node.namedChild(1);
  if (!suffix || suffix.type !== "call_suffix") return null;
  let args: TSNode | null = null;
  let trailing = false;
  for (let i = 0; i < suffix.namedChildCount; i++) {
    const part = suffix.namedChild(i)!;
    if (part.type === "value_arguments") args ??= part;
    else if (part.type === "lambda_literal") trailing = true;
  }
  return { args, subscript: args?.child(0)?.type === "[", trailing };
}

function segmentsOf(node: TSNode): Segment[] {
  switch (node.type) {
    case "simple_identifier":
      // A closure's `$0` or a wrapper's `$name` names no declared receiver: the patterns read the bare method.
      return node.text.startsWith("$") ? [{ kind: "other", bare: true }] : [{ kind: "id", name: node.text, node }];
    case "self_expression":
      return [{ kind: "id", name: "self", node }];
    case "super_expression":
      return [{ kind: "id", name: "super", node }];
    case "navigation_expression": {
      const target = node.childForFieldName("target");
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      const base = target ? segmentsOf(target) : [];
      if (member?.type === "simple_identifier") return [...base, { kind: "id", name: member.text, node: member }];
      return [...base, { kind: "other", bare: member?.type === "integer_literal" }];
    }
    case "postfix_expression": {
      // `x!.f(` / `x?.f(` call through `x`.
      const op = node.childForFieldName("operation")?.type;
      const target = node.childForFieldName("target");
      return target && (op === "bang" || op === "?") ? segmentsOf(target) : [{ kind: "other", bare: false }];
    }
    case "try_expression":
    case "await_expression": {
      // `(try repo.find(id)).first()` as the grammar groups `try repo.find(id).first()`.
      const inner = node.childForFieldName("expr");
      return inner ? segmentsOf(inner) : [{ kind: "other", bare: false }];
    }
    case "prefix_expression": {
      // The grammar binds a prefix operator before the call it applies to: `!isOperator(name:)` calls `isOperator`,
      // and an implicit member `.shared.f(` reads as `shared.f`.
      const target = node.childForFieldName("target");
      return target ? segmentsOf(target) : [{ kind: "other", bare: false }];
    }
    case "call_expression": {
      const suffix = suffixOf(node);
      const callee = node.namedChild(0);
      if (!suffix || !callee || suffix.subscript) return [{ kind: "other", bare: false }];
      const inner = segmentsOf(callee);
      const only = inner.length === 1 ? inner[0]! : null;
      const constructs = only?.kind === "id" && /^[A-Z]/.test(only.name) ? only.name : undefined;
      return [...inner, { kind: "call", ...(constructs ? { constructs } : {}) }];
    }
    default:
      return [{ kind: "other", bare: /literal$/.test(node.type) }];
  }
}

/**
 * The chain a call's result is named by — `repo.find()`, `repo.find().first()`, `Club.load()` for a method on a
 * construction — as the names before each `()`, or null when a step has no name.
 */
function chainOf(segments: Segment[]): { parts: string[]; head: TSNode } | null {
  const last = segments.at(-1);
  if (last?.kind !== "call") return null;
  const callee = segments.slice(0, -1);
  const name = callee.at(-1);
  if (name?.kind !== "id") return null;
  const prev = callee.at(-2);
  if (!prev) return { parts: [name.name], head: name.node };
  if (prev.kind === "id") return callee.at(-3)?.kind === "call" || callee.at(-3)?.kind === "other" ? null : { parts: [`${prev.name}.${name.name}`], head: prev.node };
  if (prev.kind !== "call") return null;
  const receiver = callee.slice(0, -1);
  if (prev.constructs && receiver.length === 2) return { parts: [`${prev.constructs}.${name.name}`], head: (receiver[0] as { node: TSNode }).node };
  const inner = chainOf(receiver);
  return inner && inner.parts.length < CHAIN_DEPTH ? { parts: [...inner.parts, name.name], head: inner.head } : null;
}

/** A container lookup a Swift DI pattern names, read off the callee's own text. */
function containerCall(node: TSNode, args: TSNode | null, text: string): PatternCallName | null {
  const callee = node.namedChild(0)!;
  const end = args?.startIndex ?? callee.endIndex;
  const source = `${text.slice(callee.startIndex, end)}(`;
  for (const pattern of swiftDiCallPatterns) {
    for (const m of source.matchAll(new RegExp(pattern.pattern.source, pattern.pattern.flags.replace("g", "") + "g"))) {
      if (m.index + m[0].length !== source.length) continue;
      const built = pattern.buildName(m, source);
      if (!built.name) return null;
      return {
        name: built.name,
        leafName: built.leafName,
        line: callee.startPosition.row + 1,
        column: callee.startPosition.column,
        ...(built.receiverType ? { receiverType: built.receiverType } : {}),
        ...(built.receiverQualifier ? { receiverQualifier: built.receiverQualifier } : {}),
      };
    }
  }
  return null;
}

function callName(node: TSNode, text: string): PatternCallName | null {
  const suffix = suffixOf(node);
  const callee = node.namedChild(0);
  if (!suffix || !callee || suffix.subscript) return null;
  const container = containerCall(node, suffix.args, text);
  if (container) return container;
  const segments = segmentsOf(callee);
  const leaf = segments.at(-1);
  if (leaf?.kind !== "id") return null;
  const ids = segments.every((s) => s.kind === "id") ? (segments as Array<Extract<Segment, { kind: "id" }>>) : null;
  // `withApp { … }`, `DispatchQueue.main.async { … }`: the whole path, as the trailing-closure pattern reads it.
  if (!suffix.args && suffix.trailing && ids) {
    if (NOT_A_CALL.has(ids[0]!.name) || /^[A-Z]/.test(leaf.name)) return null;
    return call(ids.map((s) => s.name).join("."), leaf.name, ids[0]!.node);
  }
  const prev = segments.at(-2);
  if (!prev) return call(leaf.name, leaf.name, leaf.node);
  if (prev.kind === "id") return call(`${prev.name}.${leaf.name}`, leaf.name, prev.node);
  if (prev.kind === "other") return prev.bare ? call(leaf.name, leaf.name, leaf.node) : null;
  const receiver = segments.slice(0, -1);
  if (prev.constructs && receiver.length === 2) return call(`${prev.constructs}.${leaf.name}`, leaf.name, (receiver[0] as { node: TSNode }).node, prev.constructs);
  const chain = chainOf(receiver);
  return chain ? call(`${chain.parts.map((p) => `${p}()`).join(".")}.${leaf.name}`, leaf.name, chain.head) : null;
}

/** `Cache<String, Club>(…)`, `League.Table<Club>(…)`: the generic type constructed, by its last two names. */
function constructorName(node: TSNode): PatternCallName | null {
  const type = node.childForFieldName("constructed_type");
  if (type?.type !== "user_type") return null;
  const names: TSNode[] = [];
  for (let i = 0; i < type.namedChildCount; i++) {
    const part = type.namedChild(i)!;
    if (part.type === "type_identifier") names.push(part);
  }
  const leaf = names.at(-1);
  if (!leaf) return null;
  const prev = names.at(-2);
  return prev ? call(`${prev.text}.${leaf.text}`, leaf.text, prev) : call(leaf.text, leaf.text, leaf);
}
