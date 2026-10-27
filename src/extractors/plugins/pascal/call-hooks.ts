import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { callArgs, pascalReceiverTypeOf } from "./di.js";

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
          if (callee.type === "inherited") return callee.text;
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

  // A container lookup chained into a call names its receiver's type:
  // `GlobalContainer.Resolve<INotifier>('sms').Send(…)`.
  receiverTypeOf: pascalReceiverTypeOf,

  // Delphi fields prefixed with F: FUserService.Save → UserService
  qualifiedRootCandidates(root) {
    if (root.startsWith("F") && root.length > 1) return [root.slice(1)];
    return [];
  },
};
