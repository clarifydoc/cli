import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";
import { scalaDiCallPatterns } from "./di.js";

/** How many calls deep a chain is named (the linker types each step through declared return types). */
const CHAIN_DEPTH = 8;

/** A `def` as the Scala spec's pattern reads it: with a body, or abstract in a trait. */
const FUNCTIONS: ReadonlySet<string> = new Set(["function_definition", "function_declaration"]);

/** Type definitions: what their bodies call outside a `def` is no function's. */
const TYPES: ReadonlySet<string> = new Set(["class_definition", "object_definition", "trait_definition", "enum_definition"]);

/** The Scala front end of the `tree-sitter:scala` feature, loaded on first use. */
export function loadScalaReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("scala", readScalaTree);
}

interface Walk {
  text: string;
  topLevel: PatternCallName[];
  functions: Array<{ span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] }>;
}

/**
 * Scala's functions and calls from a tree-sitter-scala tree. A function is a `def` — a member, a local one, an
 * extension method or a trait's abstract one — spanning its name's line to its body's end, and owns the calls in its
 * body except those of a `def` inside it; a lambda's calls are its owner's, and so are an anonymous instance's
 * methods' (`new Handler { def run() = … }`), which keep theirs too; a type's own body is no function's. A call has
 * an argument list in parentheses or a block (`Action.async { implicit request => … }`); a parameterless
 * member (`.toList`) and an infix call (`list map f`) are none, as the patterns read them; a constructor pattern
 * (`case Goal(minute) =>`) calls its extractor, and is named by its type. A call is named by the
 * Scala spec's call patterns where one reads its callee's text (`injector.instanceOf[Repo].save(`), else by its last
 * two names (`this.repo.cache.size()` is `cache.size`); where the patterns name nothing the parser still can: a
 * method on a call's result is the chain from its first call (`repo.find(id).map`), one on a construction the
 * type's (`Club(1).save()` is `Club.save` on `Club`), and calls written over several lines are read whole.
 */
export function readScalaTree(root: TSNode, text: string): ParsedStructure {
  const topLevel: PatternCallName[] = [];
  const walk: Walk = { text, topLevel, functions: [] };
  visit(root, topLevel, walk);
  walk.functions.sort((a, b) => a.span.line - b.span.line);
  return {
    functions: walk.functions.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) })),
    topLevelCalls: recordPatternCalls(topLevel),
    syntaxErrors: countSyntaxErrors(root),
  };
}

/**
 * `lend`: the calls of the function that builds an anonymous instance (`new ToHandler[…] { def toHandler(…) = … }`),
 * to which that instance's methods lend theirs. They run later, as a lambda does, and nothing links the builder to
 * them by name, so the builder's path to what they call would be lost; a local `def` is called by name and lends
 * nothing.
 */
function visit(node: TSNode, owner: PatternCallName[] | null, walk: Walk, lend: PatternCallName[] | null = null): void {
  for (let i = 0; i < node.namedChildCount; i++) visitNode(node.namedChild(i)!, owner, walk, lend);
}

function visitNode(node: TSNode, owner: PatternCallName[] | null, walk: Walk, lend: PatternCallName[] | null = null): void {
  if (FUNCTIONS.has(node.type)) {
    const name = node.childForFieldName("name");
    const calls: PatternCallName[] = [];
    if (name && /^[A-Za-z_]\w*$/.test(name.text)) {
      walk.functions.push({ span: { name: name.text, line: name.startPosition.row + 1, endLine: node.endPosition.row + 1 }, calls });
    }
    const body = node.childForFieldName("body");
    if (body) visitNode(body, calls, walk);
    if (lend) lend.push(...calls);
    return;
  }
  if (TYPES.has(node.type)) {
    visit(node, owner === walk.topLevel ? null : owner, walk);
    return;
  }
  if (owner && node.type === "call_expression") {
    const named = callName(node, walk.text);
    if (named) owner.push(named);
  } else if (owner && node.type === "case_class_pattern") {
    // `case Goal(minute) =>` calls the extractor `Goal.unapply`: a use of the case class, as the patterns read `Goal(`.
    const type = node.childForFieldName("type");
    if (type) {
      const names = type.text.split(".");
      const leaf = names.at(-1)!;
      owner.push({ name: names.length >= 2 ? `${names.at(-2)}.${leaf}` : leaf, leafName: leaf, line: type.startPosition.row + 1, column: type.startPosition.column });
    }
  } else if (owner && node.type === "instance_expression") {
    const named = constructionName(node);
    if (named) owner.push(named);
    // The members of `new X { … }` lend their calls to the function building it.
    visit(node, owner, walk, owner === walk.topLevel ? null : owner);
    return;
  }
  visit(node, owner, walk, node.type === "template_body" ? lend : null);
}

const idStep = (name: string, node: TSNode): CalleeStep => ({ kind: "id", name, line: node.startPosition.row + 1, column: node.startPosition.column });

/** A callee as steps: names and members, a call's result as a call, a string's methods read bare. */
function stepsOf(node: TSNode): CalleeStep[] {
  switch (node.type) {
    case "identifier":
      return [idStep(node.text, node)];
    // A placeholder lambda's receiver (`filter(_.byRepository(owner))`), spelled as the patterns spell it.
    case "wildcard":
      return [idStep("_", node)];
    // `new MergeCacheInfo(…).squash(…)`: a method on a construction is the type's.
    case "instance_expression": {
      const built = constructionName(node);
      return built ? [{ kind: "id", name: built.leafName, line: built.line, column: built.column }, { kind: "call", constructs: built.leafName }] : [{ kind: "other", bare: false }];
    }
    case "field_expression": {
      const value = node.childForFieldName("value");
      const field = node.childForFieldName("field");
      if (!value || field?.type !== "identifier") return [{ kind: "other", bare: false }];
      return [...stepsOf(value), idStep(field.text, field)];
    }
    case "generic_function": {
      const fn = node.childForFieldName("function");
      return fn ? stepsOf(fn) : [{ kind: "other", bare: false }];
    }
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (!fn) return [{ kind: "other", bare: false }];
      const inner = stepsOf(fn);
      return [...inner, callStep(inner)];
    }
    default:
      return [{ kind: "other", bare: /string|literal/.test(node.type) }];
  }
}

function callName(node: TSNode, text: string): PatternCallName | null {
  const fn = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (!fn || !args) return null;
  const at = fn.startPosition;
  const byPattern = patternNamedCall(`${text.slice(fn.startIndex, args.startIndex)}(`, scalaDiCallPatterns, at.row + 1, at.column);
  if (byPattern !== undefined) return byPattern;
  return nameCall(stepsOf(fn), CHAIN_DEPTH);
}

/** `new PgRepo(db)`: the type built, by its last two names, as the patterns read `PgRepo(`. */
function constructionName(node: TSNode): PatternCallName | null {
  let type: TSNode | null = null;
  for (let i = 0; i < node.namedChildCount && !type; i++) {
    const part = node.namedChild(i)!;
    if (part.type === "type_identifier" || part.type === "stable_type_identifier") type = part;
    else if (part.type === "generic_type") type = part.childForFieldName("type");
  }
  let hasArgs = false;
  for (let i = 0; i < node.namedChildCount; i++) if (node.namedChild(i)!.type === "arguments") hasArgs = true;
  if (!type || !hasArgs) return null;
  const names = type.text.split(".");
  const leaf = names.at(-1)!;
  const name = names.length >= 2 ? `${names.at(-2)}.${leaf}` : leaf;
  return { name, leafName: leaf, line: type.startPosition.row + 1, column: type.startPosition.column };
}
