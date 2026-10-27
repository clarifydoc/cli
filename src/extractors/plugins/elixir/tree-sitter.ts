import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, type CalleeStep } from "../shared/callee-names.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";

/** How many calls deep a chain is named. */
const CHAIN_DEPTH = 8;

/** The definitions the Elixir spec's function pattern reads. */
const DEFINITIONS: ReadonlySet<string> = new Set(["def", "defp", "defmacro", "defmacrop"]);

/** Module definitions: what their own bodies call outside a function is no function's. */
const MODULES: ReadonlySet<string> = new Set(["defmodule", "defprotocol", "defimpl"]);

/** Template sigils: HEEx `~H`, the older `~L`, EEx `~E` and Surface `~F`, whose markup holds Elixir expressions. */
const TEMPLATE_SIGILS: ReadonlySet<string> = new Set(["H", "L", "E", "F"]);

/** A call in template markup as the patterns read a line: a name or `Module.name`, then `(`. */
const TEMPLATE_CALL = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?[?!]?)\s*\(/g;

/** The Elixir front end of the `tree-sitter:elixir` feature, loaded on first use. */
export function loadElixirReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("elixir", readElixirTree);
}

interface Walk {
  topLevel: PatternCallName[];
  functions: Array<{ span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] }>;
}

/**
 * Elixir's functions and calls from a tree-sitter-elixir tree. A function is a `def`/`defp`/`defmacro`/`defmacrop`
 * clause — each clause its own, as the patterns read them — spanning its line to its `end` (or its `do:` body), and
 * owns the calls in its body, guard and default arguments; an anonymous function's calls are its owner's, a
 * module's own body (`plug`, `schema`, `field`) is no function's. A call is one with arguments: `socket.assigns` is a
 * field read. A remote call is named by its last two names, as the patterns name it (`MyApp.Accounts.get_user!(id)`
 * is `Accounts.get_user!`), with or without parentheses (`Repo.insert! changeset`); a local one only with them, since
 * a paren-less local call is a macro of a DSL (`get "/", PageController, :index`, `field :name`). Unlike the patterns,
 * a name ending in `!` or `?` is read (`Repo.get!(Player, id)`), and calls written over several lines are. The
 * grammar reads a template sigil (`~H"""…"""`) as text: its expressions (`phx-click={show_modal("x")}`,
 * `<%= render_slot(@inner_block) %>`) are read line by line as the patterns read them.
 */
export function readElixirTree(root: TSNode): ParsedStructure {
  const topLevel: PatternCallName[] = [];
  const walk: Walk = { topLevel, functions: [] };
  visit(root, topLevel, walk);
  walk.functions.sort((a, b) => a.span.line - b.span.line);
  return {
    functions: walk.functions.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) })),
    topLevelCalls: recordPatternCalls(topLevel),
    syntaxErrors: countSyntaxErrors(root),
  };
}

function namedChildren(node: TSNode): TSNode[] {
  const out: TSNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

/** `def`, `defmodule`, `alias`: the macro a call with a bare target invokes. */
function macroOf(call: TSNode): string | null {
  const target = call.childForFieldName("target");
  return target?.type === "identifier" ? target.text : null;
}

/** A definition's name: `get!(id)`, `index conn, _`, `build(attrs) when is_map(attrs)`; null for `unquote(name)`. */
function definitionName(head: TSNode | undefined): TSNode | null {
  if (!head) return null;
  if (head.type === "binary_operator") return definitionName(head.childForFieldName("left") ?? undefined);
  if (head.type === "identifier") return head;
  if (head.type === "call") {
    const target = head.childForFieldName("target");
    return target?.type === "identifier" && target.text !== "unquote" ? target : null;
  }
  return null;
}

function visit(node: TSNode, owner: PatternCallName[] | null, walk: Walk): void {
  for (const child of namedChildren(node)) visitNode(child, owner, walk);
}

function visitNode(node: TSNode, owner: PatternCallName[] | null, walk: Walk): void {
  if (node.type === "sigil" && owner && TEMPLATE_SIGILS.has(namedChildren(node).find((c) => c.type === "sigil_name")?.text ?? "")) {
    for (const content of namedChildren(node)) if (content.type === "quoted_content") templateCalls(content, owner);
    return;
  }
  if (node.type !== "call") {
    visit(node, owner, walk);
    return;
  }
  const macro = macroOf(node);
  if (macro && DEFINITIONS.has(macro)) {
    definition(node, owner, walk);
    return;
  }
  if (macro && MODULES.has(macro)) {
    visit(node, owner === walk.topLevel ? null : owner, walk);
    return;
  }
  if (owner) {
    const named = callName(node);
    if (named) owner.push(named);
  }
  visit(node, owner, walk);
}

/**
 * A head's calls, all but its name: a default argument (`status \\ Status.in_progress()`) and a guard
 * (`when length(steps) in Funnel.min_steps()..Funnel.max_steps()`) run when the function is called.
 */
function headCalls(head: TSNode | undefined, calls: PatternCallName[] | null, walk: Walk): void {
  if (!head) return;
  if (head.type === "binary_operator") {
    headCalls(head.childForFieldName("left") ?? undefined, calls, walk);
    const guard = head.childForFieldName("right");
    if (guard) visitNode(guard, calls, walk);
  } else if (head.type === "call") {
    for (const part of namedChildren(head)) if (part.type === "arguments") visit(part, calls, walk);
  }
}

/** A `def` clause: a function of its own when it has a name, its body walked either way. */
function definition(call: TSNode, owner: PatternCallName[] | null, walk: Walk): void {
  const args = namedChildren(call).find((c) => c.type === "arguments");
  const parts = args ? namedChildren(args) : [];
  const name = definitionName(parts[0]);
  let calls = owner;
  if (name) {
    calls = [];
    walk.functions.push({ span: { name: name.text, line: call.startPosition.row + 1, endLine: call.endPosition.row + 1 }, calls });
  }
  headCalls(parts[0], calls, walk);
  // `do … end`, and the one-line `, do: expr` among the arguments.
  for (const part of namedChildren(call)) if (part.type === "do_block") visit(part, calls, walk);
  for (const part of parts.slice(1)) if (part.type === "keywords") visit(part, calls, walk);
}

/**
 * A template line with its string literals (attribute values) blanked, but not the `#{…}` interpolations in them:
 * `title={"Added at #{format_added_at(rule.inserted_at)}"}` calls `format_added_at`.
 */
function blankStrings(line: string): string {
  let out = "";
  let inString = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      out += depth === 0 ? " " : c;
    } else if (inString && c === "#" && line[i + 1] === "{") {
      depth = 1;
      out += "  ";
      i++;
    } else if (c === "\\" && inString) {
      out += "  ";
      i++;
    } else if (c === '"') {
      inString = !inString;
      out += " ";
    } else {
      out += inString ? " " : c;
    }
  }
  return out;
}

/** The calls in a template's markup, read off its lines with string literals blanked. */
function templateCalls(content: TSNode, owner: PatternCallName[]): void {
  content.text.split("\n").forEach((raw, i) => {
    const line = blankStrings(raw);
    for (const m of line.matchAll(TEMPLATE_CALL)) {
      const name = m[1]!;
      const column = (i === 0 ? content.startPosition.column : 0) + m.index!;
      owner.push({ name, leafName: name.split(".").pop()!, line: content.startPosition.row + i + 1, column });
    }
  });
}

const idStep = (name: string, node: TSNode): CalleeStep => ({ kind: "id", name, line: node.startPosition.row + 1, column: node.startPosition.column });

/** A callee as steps: `Repo` and `MyApp.Repo` by their last name, `:crypto` by its atom, a call's result as a call. */
function stepsOf(node: TSNode): CalleeStep[] {
  switch (node.type) {
    case "identifier":
      return [idStep(node.text, node)];
    case "alias": {
      const last = node.text.split(".").pop()!;
      return [idStep(last, node)];
    }
    case "atom":
      return [idStep(node.text.replace(/^:/, ""), node)];
    case "call": {
      const target = node.childForFieldName("target");
      if (!target || !namedChildren(node).some((c) => c.type === "arguments")) return target ? stepsOf(target) : [{ kind: "other", bare: false }];
      const inner = stepsOf(target);
      return [...inner, callStep(inner)];
    }
    case "dot": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (!left || right?.type !== "identifier") return [{ kind: "other", bare: false }];
      return [...stepsOf(left), idStep(right.text, right)];
    }
    default:
      return [{ kind: "other", bare: false }];
  }
}

function callName(call: TSNode): PatternCallName | null {
  const args = namedChildren(call).find((c) => c.type === "arguments");
  const target = call.childForFieldName("target");
  if (!args || !target) return null;
  const parenthesized = args.child(0)?.type === "(";
  // A paren-less local call is a DSL macro (`get "/", …`, `field :name`); a remote one is a call.
  if (!parenthesized && target.type !== "dot") return null;
  return nameCall(stepsOf(target), CHAIN_DEPTH);
}
