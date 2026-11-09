import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
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
export function loadSwiftReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("swift", readSwiftTree);
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
    } else if (type === "property_declaration") {
      // A computed property (`var body: some View { … }`, `get`/`set`) or observed one (`didSet`) runs code on access:
      // one function named for the property, owning the calls of every accessor.
      const property = accessorProperty(node);
      if (property) {
        calls = [];
        functions.push({ span: { name: property.name, line: property.row + 1, endLine: node.endPosition.row + 1 }, calls });
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
    syntaxErrors: countSyntaxErrors(root),
  };
}

/**
 * The name and keyword row of a property whose accessors have code — a computed body, `get`/`set`, `willSet`/`didSet`
 * — or null for a stored property and a protocol requirement (`{ get set }`, no statements).
 */
function accessorProperty(node: TSNode): { name: string; row: number } | null {
  let name = "";
  let row = -1;
  let hasBody = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === "value_binding_pattern") row = child.startPosition.row;
    else if (child.type === "pattern" && !name) name = child.namedChild(0)?.type === "simple_identifier" ? child.namedChild(0)!.text : "";
    else if (child.type === "computed_property" || child.type === "willset_didset_block") hasBody = hasStatements(child);
  }
  return hasBody && name && row >= 0 ? { name, row } : null;
}

function hasStatements(node: TSNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === "statements" || hasStatements(child)) return true;
  }
  return false;
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

const call = (name: string, leafName: string, at: TSNode): PatternCallName => ({
  name,
  leafName,
  line: at.startPosition.row + 1,
  column: at.startPosition.column,
});

const idStep = (name: string, node: TSNode): CalleeStep => ({ kind: "id", name, line: node.startPosition.row + 1, column: node.startPosition.column });

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

/** A callee as steps; `"s".f(` and a tuple field `x.0.f(` are receivers the patterns read the bare method on. */
function stepsOf(node: TSNode): CalleeStep[] {
  switch (node.type) {
    case "simple_identifier":
      // A closure's `$0` or a wrapper's `$name` names no declared receiver: the patterns read the bare method.
      // A positional closure argument (`$0`) is a receiver of its own: typed when a typed collection hands it over.
      if (/^\$\d+$/.test(node.text)) return [idStep(node.text, node)];
      return node.text.startsWith("$") ? [{ kind: "other", bare: true }] : [idStep(node.text, node)];
    case "self_expression":
      return [idStep("self", node)];
    case "super_expression":
      return [idStep("super", node)];
    case "navigation_expression": {
      const target = node.childForFieldName("target");
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      const base = target ? stepsOf(target) : [];
      if (member?.type === "simple_identifier") return [...base, idStep(member.text, member)];
      return [...base, { kind: "other", bare: member?.type === "integer_literal" }];
    }
    case "postfix_expression": {
      // `x!.f(` / `x?.f(` call through `x`.
      const op = node.childForFieldName("operation")?.type;
      const target = node.childForFieldName("target");
      return target && (op === "bang" || op === "?") ? stepsOf(target) : [{ kind: "other", bare: false }];
    }
    case "try_expression":
    case "await_expression": {
      // `(try repo.find(id)).first()` as the grammar groups `try repo.find(id).first()`.
      const inner = node.childForFieldName("expr");
      return inner ? stepsOf(inner) : [{ kind: "other", bare: false }];
    }
    case "prefix_expression": {
      // The grammar binds a prefix operator before the call it applies to: `!isOperator(name:)` calls `isOperator`,
      // and an implicit member `.shared.f(` reads as `shared.f`.
      const target = node.childForFieldName("target");
      return target ? stepsOf(target) : [{ kind: "other", bare: false }];
    }
    case "call_expression": {
      const suffix = suffixOf(node);
      const callee = node.namedChild(0);
      if (!suffix || !callee || suffix.subscript) return [{ kind: "other", bare: false }];
      const inner = stepsOf(callee);
      return [...inner, callStep(inner)];
    }
    default:
      return [{ kind: "other", bare: /literal$/.test(node.type) }];
  }
}

function callName(node: TSNode, text: string): PatternCallName | null {
  const suffix = suffixOf(node);
  const callee = node.namedChild(0);
  if (!suffix || !callee || suffix.subscript) return null;
  // A container lookup a DI pattern names, read off the callee's own text.
  const source = `${text.slice(callee.startIndex, suffix.args?.startIndex ?? callee.endIndex)}(`;
  const container = patternNamedCall(source, swiftDiCallPatterns, callee.startPosition.row + 1, callee.startPosition.column);
  if (container !== undefined) return container;
  const steps = stepsOf(callee);
  const leaf = steps.at(-1);
  if (leaf?.kind !== "id") return null;
  // `withApp { … }`, `DispatchQueue.main.async { … }`: the whole path, as the trailing-closure pattern reads it.
  if (!suffix.args && suffix.trailing && steps.every((s) => s.kind === "id")) {
    const ids = steps as Array<Extract<CalleeStep, { kind: "id" }>>;
    if (NOT_A_CALL.has(ids[0]!.name) || /^[A-Z]/.test(leaf.name)) return null;
    return { name: ids.map((s) => s.name).join("."), leafName: leaf.name, line: ids[0]!.line, column: ids[0]!.column };
  }
  return nestedConstruction(steps) ?? fieldPathCall(steps) ?? nameCall(steps, CHAIN_DEPTH, { paths: true });
}

/**
 * `League.Table(…)`, `Vapor.Application(…)`: a construction through the type that nests it (or the module that
 * declares it) keeps its path: the nested class is recorded under its path (`League::Table`, an `extension
 * League.Table` too), and the linker takes the longest tail of the path some class is declared at.
 */
function nestedConstruction(steps: readonly CalleeStep[]): PatternCallName | null {
  if (steps.length < 2 || !steps.every((s) => s.kind === "id")) return null;
  const ids = steps as Array<Extract<CalleeStep, { kind: "id" }>>;
  const leaf = ids.at(-1)!;
  if (!/^[A-Z]/.test(leaf.name) || !/^[A-Z]/.test(ids.at(-2)!.name)) return null;
  return { name: ids.map((s) => s.name).join("."), leafName: leaf.name, line: ids[0]!.line, column: ids[0]!.column };
}

/**
 * A call through a stored property of a lowercase receiver — `car.radio.start(`, `self.car.radio.start(` — keeps
 * its whole path (`car.radio.start`), so the linker types it field by field: `car` by its declaration, `radio` by
 * the property's. `self.repo.find(` stays `repo.find`; a type's static member (`PlayerService.shared.add(`) keeps its
 * path too, through `nameCall`'s `paths`.
 */
function fieldPathCall(steps: readonly CalleeStep[]): PatternCallName | null {
  if (!steps.every((s) => s.kind === "id")) return null;
  const ids = (steps as Array<Extract<CalleeStep, { kind: "id" }>>).slice(steps[0]!.kind === "id" && (steps[0] as { name: string }).name === "self" ? 1 : 0);
  if (ids.length < 3 || !/^[a-z_]/.test(ids[0]!.name) || ids.some((s) => s.name === "self" || s.name === "super")) return null;
  const leaf = ids.at(-1)!;
  return { name: ids.map((s) => s.name).join("."), leafName: leaf.name, line: ids[0]!.line, column: ids[0]!.column };
}

/** `Cache<String, Club>(…)`, `League.Table<Club>(…)`: the generic type constructed, by its own name. */
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
  return call(leaf.text, leaf.text, leaf);
}
