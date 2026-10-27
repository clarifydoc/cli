import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";

/** A top-level declaration that defines a function: an equation, or a binding without arguments. */
const DEFINITIONS: ReadonlySet<string> = new Set(["function", "bind"]);

/** The Haskell front end of the `tree-sitter:haskell` feature, loaded on first use. */
export function loadHaskellReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("haskell", readHaskellTree);
}

/**
 * Haskell's functions and calls from a tree-sitter-haskell tree. A function is a top-level definition: its signature
 * and its equations (`findClub db cid = …`, `findClub _ 0 = …`) are one function, spanning the first to the last, as
 * the patterns read a signature's block; a `where` or `let` definition's calls are its owner's, and a CPP line
 * between them (`#if`/`#else`) is skipped. An instance's methods are named by the instance's type
 * (`instance ToJSON Club where toJSON c = …` is `Club.toJSON`) and a type class's default methods by the class
 * (`Ranked.rank`): reached through the class's dispatch, never by their bare name, which would let a project's
 * `toJSON` catch every `toJSON x`. A call is a function applied to arguments — Haskell writes no parentheses
 * (`query db sql`), which the patterns could only read as `query (…)` — and is named by its head: a name (`query`), a
 * qualified name by its last two (`Data.Map.lookup` is `Map.lookup`), or a name used infix (`` x `orElse` y ``).
 * Operators and data constructors (`Just x`, `Only cid`) are none.
 */
export function readHaskellTree(root: TSNode): ParsedStructure {
  const functions: Functions = [];
  const declarations = root.childForFieldName("declarations");
  if (declarations) readDeclarations(declarations, "", functions);
  functions.sort((a, b) => a.span.line - b.span.line);
  return {
    functions: functions.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) })),
    topLevelCalls: [],
    syntaxErrors: countSyntaxErrors(root),
  };
}

type Functions = Array<{ span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] }>;

/**
 * The definitions of a declaration list — the module's, an instance's or a class's — each name's signature and
 * consecutive equations one function, named `${owner}.${name}` inside an instance or class.
 */
function readDeclarations(list: TSNode, owner: string, functions: Functions): void {
  let current = null as { name: string; span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] } | null;
  let signatureAt = null as { name: string; line: number } | null;
  for (let i = 0; i < list.namedChildCount; i++) {
    const decl = list.namedChild(i)!;
    if (decl.type === "cpp") continue;
    if (decl.type === "signature") {
      const name = decl.childForFieldName("name")?.text;
      // `#if`/`#else` may give one name two signatures: the function starts at the first.
      if (signatureAt?.name !== name) signatureAt = name ? { name, line: decl.startPosition.row + 1 } : null;
      continue;
    }
    if (decl.type === "instance" || decl.type === "class") {
      const inner = decl.childForFieldName("declarations");
      const typeName = memberOwner(decl);
      if (inner && typeName) readDeclarations(inner, typeName, functions);
      signatureAt = null;
      current = null;
      continue;
    }
    if (!DEFINITIONS.has(decl.type)) {
      signatureAt = null;
      current = null;
      continue;
    }
    const bare = decl.childForFieldName("name")?.text;
    if (!bare) continue;
    const name = owner ? `${owner}.${bare}` : bare;
    if (current?.name !== name) {
      const line = signatureAt?.name === bare ? signatureAt.line : decl.startPosition.row + 1;
      current = { name, span: { name, line, endLine: decl.endPosition.row + 1 }, calls: [] };
      functions.push(current);
    }
    current.span.endLine = decl.endPosition.row + 1;
    signatureAt = null;
    calls(decl, current.calls);
  }
}

/** The type an instance is for (`instance ToJSON Club` → `Club`, `instance Show (Tree a)` → `Tree`), or a class's name. */
function memberOwner(decl: TSNode): string | null {
  if (decl.type === "class") return decl.childForFieldName("name")?.text ?? null;
  const patterns = decl.childForFieldName("patterns");
  const stack = patterns ? [patterns] : [];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === "name") return n.text;
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }
  return decl.childForFieldName("name")?.text ?? null;
}

/** The calls under `node`: each application once, at its outermost `apply`, and each name used infix. */
function calls(node: TSNode, out: PatternCallName[]): void {
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // `f a b` is `apply(apply(f, a), b)`: one call, read at the apply that is no other's function.
    const inner = n.parent?.type === "apply" && n.parent.childForFieldName("function")?.id === n.id;
    if (n.type === "apply" && !inner) {
      const named = headName(n);
      if (named) out.push(named);
    } else if (n.type === "infix") {
      const op = n.childForFieldName("operator");
      if (op?.type === "infix_id") {
        const named = nameOf(op.namedChild(0));
        if (named) out.push(named);
      }
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
}

/** The function an application chain applies: the leftmost `function` of nested `apply`s. */
function headName(apply: TSNode): PatternCallName | null {
  let head: TSNode | null = apply;
  while (head?.type === "apply") head = head.childForFieldName("function");
  return nameOf(head);
}

/** A name a call is made by: a variable, or a qualified one by its module's last name. */
function nameOf(node: TSNode | null): PatternCallName | null {
  if (!node) return null;
  const at = { line: node.startPosition.row + 1, column: node.startPosition.column };
  if (node.type === "variable") return { name: node.text, leafName: node.text, ...at };
  if (node.type === "qualified") {
    const id = node.childForFieldName("id");
    // The module's text carries the dot before the name (`Standings.`).
    const module = node.childForFieldName("module")?.text.replace(/\.$/, "").split(".").pop();
    if (id?.type !== "variable" || !module) return null;
    return { name: `${module}.${id.text}`, leafName: id.text, ...at };
  }
  return null;
}
