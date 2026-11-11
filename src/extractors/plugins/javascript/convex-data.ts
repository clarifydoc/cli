import type { Node } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";
import { CONVEX_PREFIX } from "./routes/convex.js";

/**
 * The Convex side of the data-source extractor (the caller gates on the file
 * naming Convex, see `namesConvex`): a client's reference to a function and the
 * `ctx.db` operations a function runs.
 */

/** A call handing a generated function reference: callee leaf → the verb the request is sent with. */
const REFERENCE_CALLS = new Map<string, string>([
  ["useQuery", "GET"],
  ["usePaginatedQuery", "GET"],
  ["useSuspenseQuery", "GET"],
  ["preloadQuery", "GET"],
  ["fetchQuery", "GET"],
  ["runQuery", "GET"],
  ["query", "GET"],
  ["onUpdate", "GET"],
  ["watchQuery", "GET"],
  ["useMutation", "POST"],
  ["fetchMutation", "POST"],
  ["runMutation", "POST"],
  ["mutation", "POST"],
  ["useAction", "POST"],
  ["fetchAction", "POST"],
  ["runAction", "POST"],
  ["action", "POST"],
  ["runAfter", "POST"],
  ["runAt", "POST"],
]);

/**
 * `useQuery(api.clubs.list, args)`, `convex.mutation(api.clubs.sign, …)`,
 * `ctx.runMutation(internal.clubs.close, …)`: the request the reference stands
 * for. A scheduler's `runAfter(0, internal.x.y)` hands it second.
 */
export function convexReference(call: Node): { method: string; target: string } | null {
  const fn = call.childForFieldName("function");
  const leaf = fn?.type === "identifier" ? fn.text : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
  const method = leaf ? REFERENCE_CALLS.get(leaf) : undefined;
  if (!method) return null;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  const ref = leaf === "runAfter" || leaf === "runAt" ? args[1] : args[0];
  if (ref?.type !== "member_expression") return null;
  const chain = ref.text.replace(/\s+/g, "").replace(/\?\./g, ".");
  const m = /^(?:api|internal)((?:\.[A-Za-z_$][\w$]*){2,})$/.exec(chain);
  if (!m) return null;
  return { method, target: `${CONVEX_PREFIX}${m[1]!.slice(1)}` };
}

const DB_OPS: Record<string, "read" | "write"> = { query: "read", get: "read", insert: "write", patch: "write", replace: "write", delete: "write" };

/** `ctx.db.patch(id, …)`, `db.query("clubs")`: the table, when the code states it. */
export function convexDbAccess(call: Node): { op: string; table: string | null; access: "read" | "write"; chain: string } | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const chain = fn.text.replace(/\s+/g, "");
  const m = /^(?:[\w$]+\.)?db\.(query|get|insert|patch|replace|delete)$/.exec(chain);
  if (!m) return null;
  const op = m[1]!;
  const first = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
  let table: string | null = null;
  if (first && (first.type === "string" || first.type === "template_string")) {
    // `query("clubs")`, `insert("clubs", …)`, and the explicit-table forms `patch("clubs", id, …)`.
    // Anything else in the string (`db.query("SELECT …")`) is another client's call.
    const t = stripQuotes(first.text);
    if (!/^[A-Za-z_]\w*$/.test(t)) return null;
    table = t;
  } else if (first && op !== "query" && op !== "insert") {
    table = idTable(call, first);
  }
  return { op, table, access: DB_OPS[op]!, chain: `ctx.db.${op}` };
}

/** The exported function (`export const x = mutation({ … })`) a node is inside. */
function enclosingFunctionDeclaration(node: Node): Node | null {
  for (let n: Node | null = node; n; n = n.parent) {
    if (n.type === "variable_declarator" && n.parent?.parent?.type === "export_statement") return n;
  }
  return null;
}

/**
 * The table an id names: a declared `args: { clubId: v.id("clubs") }`, a
 * parameter typed `Id<"clubs">`, or an id the function just inserted
 * (`const id = await ctx.db.insert("clubs", …)`).
 */
function idTable(call: Node, idArg: Node): string | null {
  const decl = enclosingFunctionDeclaration(call);
  if (!decl) return null;
  const name = idArg.type === "member_expression" ? idArg.childForFieldName("property")?.text : idArg.type === "identifier" ? idArg.text : null;
  if (!name || !/^[\w$]+$/.test(name)) return null;
  const text = decl.text;
  const esc = name.replace(/\$/g, "\\$");
  const validator = new RegExp(`\\b${esc}\\s*:\\s*v\\s*\\.\\s*(?:optional\\s*\\(\\s*)?id\\s*\\(\\s*["'](\\w+)["']`).exec(text)?.[1];
  if (validator) return validator;
  const typed = new RegExp(`\\b${esc}\\s*\\??\\s*:\\s*Id\\s*<\\s*["'](\\w+)["']\\s*>`).exec(text)?.[1];
  if (typed) return typed;
  return new RegExp(`\\b${esc}\\s*=\\s*await\\s+[\\w$]+\\.db\\.insert\\s*\\(\\s*["'](\\w+)["']`).exec(text)?.[1] ?? null;
}
