import type { Node, Tree } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { callArgs, fieldChildren, pascalReceiverTypeOf } from "./di.js";

/** Control-transfer std procedures — statement-position identifiers that are
 *  never interesting call edges. */
const PASCAL_STATEMENT_NOISE = new Set(["exit", "break", "continue", "halt", "abort"]);

/**
 * An argument that names a dataset: `X.DataSet`, or a component named the way
 * Delphi names them (`qryPupils`, `dsAddress`, `srcPlayers`, `IBDataset`,
 * `cdsSquad`, `PlayerQuery`). Only calls passing one keep their arguments — a
 * routine called hundreds of times with constants (`LlDefineVariableExt('X', v,
 * LL_TEXT)`) must stay one call.
 */
const DATASET_ARG = /^[A-Za-z_]\w*\.DataSet$|^(?:qry|query|ds|dts|src|cds|mem|tbl|table|sp|ib|fib|fd|ado|rx|zq|uni|sql)[A-Z_0-9]\w*$|^\w*(?:Query|Qry|DataSet|Dataset|Table|Tbl)$/;

/**
 * `inherited;` / `inherited Rest` / `inherited Rest(1)`: the base class's method — the
 * enclosing one's own name when none is written (or the same one is), spelled `super`
 * as the linker re-dispatches it, else `super.Rest`.
 */
function inheritedCallName(node: Node): string {
  const named = node.namedChildren.find((c) => c.type === "identifier")?.text;
  if (!named) return "super";
  let p: Node | null = node.parent;
  while (p && p.type !== "defProc") p = p.parent;
  const header = p?.childForFieldName("header");
  const nameNode = header?.childForFieldName("name");
  const own = nameNode?.type === "genericDot" ? nameNode.childForFieldName("rhs")?.text : nameNode?.text;
  return own && own.toLowerCase() === named.toLowerCase() ? "super" : `super.${named}`;
}

/** Declarations whose `name` is a value, never a routine: a read of one runs no code. */
const VALUE_DECLS = ["declVar", "declField", "declConst", "declArg", "declEnumValue", "declType"];

/** Per parsed file, the lower-cased names it declares as values (variables, fields, constants, parameters, enum members, types). */
const valueNamesByTree = new WeakMap<Tree, Set<string>>();

function valueNames(tree: Tree): Set<string> {
  let names = valueNamesByTree.get(tree);
  if (!names) {
    names = new Set();
    for (const decl of tree.rootNode.descendantsOfType(VALUE_DECLS)) {
      if (!decl) continue;
      for (const n of fieldChildren(decl, "name")) if (n.type === "identifier") names.add(n.text.toLowerCase());
    }
    valueNamesByTree.set(tree, names);
  }
  return names;
}

/** Bare names that are never a routine of the project: the result, the instance, literals. */
const BARE_VALUES = new Set(["result", "self", "true", "false", "nil"]);

/**
 * A bare name that can only be a value by how it is written: a type (`TCar`), a
 * constant in capitals (`MB_OK`) or a prefixed enum member (`mrOk`, `clRed`).
 */
const VALUE_SHAPED = /^T[A-Z]|^[A-Z][A-Z0-9_]+$|^[a-z]{1,3}[A-Z]/;

/** The same for the last name of a chain, where a lower-case prefix is a method's own spelling. */
const MEMBER_VALUE_SHAPED = /^T[A-Z]|^[A-Z][A-Z0-9_]+$/;

/** `ACar.Shine`, `dmLeague.Clubs.Count`: a chain of names only, no call, index or cast inside. */
function nameChain(node: Node): boolean {
  let n: Node | null = node;
  while (n?.type === "exprDot") {
    if (n.childForFieldName("rhs")?.type !== "identifier") return false;
    n = n.childForFieldName("lhs");
  }
  return n?.type === "identifier";
}

/** Inside a `with` statement's body, where a bare or leading name may be the subject's member. */
function insideWith(node: Node): boolean {
  for (let p: Node | null = node.parent; p && p.type !== "defProc"; p = p.parent) {
    if (p.type === "with") return true;
  }
  return false;
}

/**
 * The subjects of the `with` statements `node` is in the body of, innermost first (a later subject of one `with`
 * before an earlier one: `with A, B do` looks in B first), for a call of a bare or dotted name. Only a subject that is a plain
 * name chain is kept: another says nothing the linker could type.
 */
function withSubjects(node: Node): string[] | null {
  const callee = node.type === "statement" ? node.children.find((c) => c.type !== "comment") : node.type === "exprCall" ? node.namedChildren[0] : null;
  // A bare name, or a dotted one whose head the subject may own (`with Dm do Clubs.Open` is `Dm.Clubs.Open`).
  if (!callee || (callee.type !== "identifier" && !(callee.type === "exprDot" && nameChain(callee) && !/^(?:self|inherited)\b/i.test(callee.text)))) return null;
  const out: string[] = [];
  for (let p: Node | null = node.parent, child: Node = node; p && p.type !== "defProc"; child = p, p = p.parent) {
    if (p.type !== "with") continue;
    const kDo = p.children.find((c) => c.type === "kDo");
    // The subjects themselves (`with Club.Next do`) are read outside the with.
    if (!kDo || child.startIndex < kDo.endIndex) continue;
    const subjects = p.namedChildren.filter((c) => c.startIndex < kDo.startIndex && c.type !== "comment");
    for (const subject of subjects.reverse()) if (nameChain(subject)) out.push(subject.text.replace(/\s+/g, ""));
  }
  return out.length > 0 ? out : null;
}

/** What one expression operand reads, when that may run a routine. */
function readOf(operand: Node | null | undefined): { name: string; node: Node } | null {
  if (!operand) return null;
  if (operand.type === "inherited") return { name: inheritedCallName(operand), node: operand };
  if (operand.type === "exprDot") {
    if (!nameChain(operand) || insideWith(operand)) return null;
    const name = operand.text.replace(/\s+/g, "");
    // `ApiController.TPlayerController`, `Consts.MAX_SQUAD`: a type or a constant named through its unit.
    return MEMBER_VALUE_SHAPED.test(name.slice(name.lastIndexOf(".") + 1)) ? null : { name, node: operand };
  }
  if (operand.type !== "identifier") return null;
  const name = operand.text;
  if (BARE_VALUES.has(name.toLowerCase()) || VALUE_SHAPED.test(name) || PASCAL_STATEMENT_NOISE.has(name.toLowerCase())) return null;
  if (valueNames(operand.tree).has(name.toLowerCase()) || insideWith(operand)) return null;
  return { name, node: operand };
}

/**
 * The operands of an expression position that read a value: an assignment's right side, a
 * condition, an operator's operands, an argument, an index, a set element. A function is
 * called there without parentheses; the linker decides from what the name resolves to.
 */
function readOperands(node: Node): Array<Node | null> {
  switch (node.type) {
    case "assignment":
    case "exprBinary": {
      const rhs = node.childForFieldName("rhs");
      if (node.type === "assignment") return [rhs];
      // `X is TCar` / `X as TCar`: the right side is a type.
      const op = node.childForFieldName("operator")?.type;
      return op === "kIs" || op === "kAs" ? [node.childForFieldName("lhs")] : [node.childForFieldName("lhs"), rhs];
    }
    case "exprUnary":
      // `@CompareClubs` takes an address: see `readNames`.
      return node.childForFieldName("operator")?.type === "kAt" ? [] : [node.childForFieldName("operand")];
    case "if":
    case "ifElse":
    case "while":
    case "repeat":
      return [node.childForFieldName("condition")];
    case "for":
      return [node.childForFieldName("end")];
    case "case":
      return [node.namedChildren.find((c) => c.type !== "comment" && !c.type.startsWith("k") && !c.type.startsWith("case")) ?? null];
    case "exprArgs":
    case "exprParens":
    case "exprBrackets":
      return node.namedChildren;
    default:
      return [];
  }
}

export const pascalCallHooks: CallExtractionHooks = {
  // Pascal calls procedures WITHOUT parentheses (`LoadTotals;`,
  // `qrySales.Open;`) — those parse as a bare identifier/exprDot directly
  // under `statement`, so statements are call nodes too.
  callNodeTypes: new Set(["exprCall", "statement"]),

  // Every routine body (`defProc`) is a scope of its own: its calls belong to
  // the routine, not ALSO to the unit-level `<setup>` pseudo-function, which
  // keeps only what runs at unit level (a program's main block,
  // `initialization`). An RTTI attribute's arguments (`[Inject('email')]`,
  // `[ResourceSuffix('/{id}')]`) are compile-time metadata, never a call.
  nestedScopeTypes: ["defProc", "rttiAttributes"],

  // exprCall with exprDot, identifier, inherited or a generic instantiation
  // (`X.Resolve<IRepo>('name')`) as callee
  resolveCallName: (node) => {
    if (node.type === "statement") {
      // Only a statement that IS a bare identifier/dotted expression is a
      // paren-less call — a generic one too (`X.RegisterType<IFoo, TFoo>;`).
      // Anything else (exprCall, assignment, if/while…) either resolves via
      // its own node or is not a call.
      const first = node.children.find((c) => c.type !== "comment");
      if (!first) return null;
      if (first.type === "inherited") return inheritedCallName(first);
      if (first.type !== "identifier" && first.type !== "exprDot" && first.type !== "exprTpl") return null;
      const name = first.text;
      const leaf = name.split(".").pop()!.toLowerCase();
      if (PASCAL_STATEMENT_NOISE.has(leaf)) return null;
      return name;
    }
    return genericResolveCallName(node, {
      extraCallee(callee, n) {
        if (n.type === "exprCall") {
          if (callee.type === "exprDot") return callee.text;
          if (callee.type === "identifier") return callee.text;
          if (callee.type === "inherited") return inheritedCallName(callee);
          if (callee.type === "exprTpl") return callee.text;
        }
        return null;
      },
    });
  },

  // A call passing a component by name (`Fill(qryPupils)`, `Print(srcPupils.DataSet)`)
  // keeps its arguments, so the project pass can follow the dataset into the
  // routine's parameter (dfm-entities.ts). Other calls keep none.
  argsOf(node) {
    if (node.type !== "exprCall") return null;
    const args = callArgs(node);
    if (args.length === 0 || args.length > 8) return null;
    // Only an identifier or a dotted name can be a dataset: read no other argument's text.
    if (!args.some((a) => (a.type === "identifier" || a.type === "exprDot") && DATASET_ARG.test(a.text))) return null;
    return args.map((a) => a.text.replace(/\s+/g, ""));
  },

  // Paren-less reads in expressions (`N := ACar.Shine`, `if qry.IsEmpty then`, `N + Points`):
  // recorded as reads, which the linker keeps only where they name a routine.
  readNames(node) {
    if (node.type === "exprUnary" && node.childForFieldName("operator")?.type === "kAt") {
      // `@CompareClubs`, `@TCar.Wash`: the routine is handed on, not run.
      const r = readOf(node.childForFieldName("operand"));
      return r && !r.name.startsWith("super") ? [{ ...r, passed: true as const }] : [];
    }
    const ops = readOperands(node);
    if (ops.length === 0) return [];
    const out: Array<{ name: string; node: Node }> = [];
    for (const op of ops) {
      const r = readOf(op);
      if (r) out.push(r);
    }
    return out;
  },

  // A bare call inside `with Club do Save;` may be the subject's own member (`Club.Save`).
  withSubjectsOf: withSubjects,

  // A container lookup chained into a call names its receiver's type:
  // `GlobalContainer.Resolve<INotifier>('sms').Send(…)`.
  receiverTypeOf: pascalReceiverTypeOf,

  // Delphi fields prefixed with F: FUserService.Save → UserService
  qualifiedRootCandidates(root) {
    if (root.startsWith("F") && root.length > 1) return [root.slice(1)];
    return [];
  },
};
