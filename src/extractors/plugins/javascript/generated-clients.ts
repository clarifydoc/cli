import type { Node } from "web-tree-sitter";
import type { DataSourceInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * Generated HTTP clients whose request shape no call site spells out.
 *
 * openapi-generator's `typescript-axios` emits one function per operation that
 * builds its path and its method in two SEPARATE locals and hands them to a
 * shared `createRequestFunction` in `common.ts`:
 *
 *     const localVarPath = `/apis/content.halo.run/v1alpha1/posts/{name}`
 *         .replace(`{${"name"}}`, encodeURIComponent(String(name)));
 *     …
 *     const localVarRequestOptions = { method: 'GET', ...baseOptions, ...options};
 *
 * No `axios.get('/x')` exists anywhere, so the generic extractor saw nothing:
 * halo's 336 generated files — 401 operations — produced no api-call at all.
 *
 * A generic "method in one variable, path in another" rule would be dataflow
 * guessing and would double-count hand-written `fetch(url, { method })`. The
 * generator's local names are reserved and stable (unchanged since 2018), so
 * this recognizes exactly that pair, gated by a substring check per file.
 */
export const GENERATED_CLIENT_MARKER = "localVarRequestOptions";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * Called on every `variable_declarator`. When it is the generator's
 * `localVarRequestOptions = { method: 'X', … }`, pair it with the
 * `localVarPath` declared in the same block and emit the operation.
 */
export function generatedClientCall(declarator: Node): DataSourceInfo | null {
  if (declarator.childForFieldName("name")?.text !== GENERATED_CLIENT_MARKER) return null;
  const options = declarator.childForFieldName("value");
  if (options?.type !== "object") return null;
  const method = methodOf(options);
  if (!method) return null;

  const block = enclosingBlock(declarator);
  if (!block) return null;
  for (const stmt of block.namedChildren) {
    if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
    for (const d of stmt.namedChildren) {
      if (d.type !== "variable_declarator" || d.childForFieldName("name")?.text !== "localVarPath") continue;
      const path = literalPath(d.childForFieldName("value"));
      if (!path) return null;
      return { kind: "api-call", name: method, target: path, line: d.startPosition.row + 1, calls: [] };
    }
  }
  return null;
}

function methodOf(options: Node): string | null {
  for (const pair of options.namedChildren) {
    if (pair.type !== "pair") continue;
    if (pair.childForFieldName("key")?.text !== "method") continue;
    const v = pair.childForFieldName("value");
    if (v?.type !== "string") return null;
    const m = stripQuotes(v.text).toLowerCase();
    return HTTP_METHODS.has(m) ? m : null;
  }
  return null;
}

function enclosingBlock(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (p.type === "statement_block") return p;
  return null;
}

/** The template or string a `localVarPath` is built from, `.replace(...)` calls peeled off; `{name}` holes kept. */
function literalPath(value: Node | null): string | null {
  let v = value;
  while (v?.type === "call_expression") {
    const fn = v.childForFieldName("function");
    if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "replace") return null;
    v = fn.childForFieldName("object");
  }
  if (v?.type !== "string" && v?.type !== "template_string") return null;
  const text = stripQuotes(v.text);
  return text.startsWith("/") ? text : null;
}
