import type { Node, Tree } from "web-tree-sitter";
import type { PathArgCall } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/** Cheap gate: some call takes a string/template starting with `/` (or `./`, `api/`, `${BASE}/`…) as an argument. */
const PATH_ARGUMENT = /[(,]\s*(?:['"`](?:\/[\w-]|[.]?[\w-]+\/)|`\$\{[\w$.]+\}\/[\w-])/;

/** `/tag`, `/system/status`, `api/v1/x`, `./x/y`, `${API_BASE}/x` — a path, not a word. */
const PATH_SHAPED = /^(?:\/[\w-]|[.]?[\w-]+\/|\$\{[\w$.]+\}\/[\w-])/;

const VERB = /^(?:get|post|put|patch|delete|head|options)$/i;

/** Clients and verbs are api-calls themselves, not factories handed a URL. */
const NOT_A_FACTORY = new Set(["fetch", "axios", "get", "post", "put", "patch", "delete", "del", "request", "ajax", "require", "import"]);

/**
 * Calls handing a path literal to a project function — the call sites of a
 * request FACTORY. Radarr's redux layer declares ~130 endpoints this way:
 *
 *     export const fetchStatus = createFetchHandler('system.status', '/system/status');
 *
 * where `createFetchHandler(section, url)` builds its request from `url`. The
 * factory's own api-call carries `${url}`; core substitutes each call site's
 * literal into it (`expandRequestFactories`). Only bare-identifier and member
 * callees with at least one path-shaped literal argument are recorded.
 */
export function extractPathArgCalls(tree: Tree, sourceText: string): PathArgCall[] {
  if (!PATH_ARGUMENT.test(sourceText)) return [];
  const out: PathArgCall[] = [];
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const callee =
      fn?.type === "identifier" ? fn.text : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
    if (!callee || NOT_A_FACTORY.has(callee.toLowerCase())) continue;
    const argNodes = call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
    const args = argNodes.map(literalArg);
    if (!args.some((a) => a !== null && PATH_SHAPED.test(a))) continue;
    // `send(url, { method: "POST", … })`: the verb the site's options state.
    const options = argNodes.find((a) => a.type === "object");
    const method = options ? methodOf(options) : null;
    out.push({ callee, args, line: call.startPosition.row + 1, ...(method ? { method } : {}) });
  }
  return out;
}

/** A string, or a template as written (its substitutions kept as `${…}` holes); anything else null. */
function literalArg(node: Node): string | null {
  if (node.type === "string" || node.type === "template_string") return stripQuotes(node.text);
  return null;
}

/** The literal `method` an options object states, upper-cased. */
function methodOf(obj: Node): string | null {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair" || stripQuotes(pair.childForFieldName("key")?.text ?? "") !== "method") continue;
    const v = pair.childForFieldName("value");
    const verb = v?.type === "string" ? stripQuotes(v.text) : null;
    return verb && VERB.test(verb) ? verb.toUpperCase() : null;
  }
  return null;
}
