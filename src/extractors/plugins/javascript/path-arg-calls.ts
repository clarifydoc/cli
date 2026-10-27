import type { Node, Tree } from "web-tree-sitter";
import type { PathArgCall } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/** Cheap gate: some call takes a string/template starting with `/` (or `./`, `api/`, `${BASE}/`…) as an argument. */
const PATH_ARGUMENT = /[(,]\s*(?:['"`](?:\/[\w-]|[.]?[\w-]+\/)|`\$\{[\w$.]+\}\/[\w-])/;

/** `/tag`, `/system/status`, `api/v1/x`, `./x/y`, `${API_BASE}/x` — a path, not a word. */
const PATH_SHAPED = /^(?:\/[\w-]|[.]?[\w-]+\/|\$\{[\w$.]+\}\/[\w-])/;

const VERB = /^(?:get|post|put|patch|delete|head|options)$/i;

/** A client-named method a project object may declare for itself (`signedUrlService.fetch(url)`). */
const OBJECT_METHOD = /^(?:fetch|request)$/i;

/** A receiver that is the HTTP client itself (`axios`, `this.http`, `$`), whose verbs are requests. */
const CLIENT_RECEIVER = /^(?:\$|jQuery|axios|https?|api|apiClient|client|request|ky|got|this|window|globalThis|self)$/i;

/** Clients and verbs are api-calls themselves, not factories handed a URL. */
const NOT_A_FACTORY = new Set(["fetch", "axios", "get", "post", "put", "patch", "delete", "del", "request", "ajax", "require", "import"]);

/**
 * Calls handing a path literal to a project function — the call sites of a
 * request FACTORY. A real app's redux layer declares ~130 endpoints this way:
 *
 *     export const fetchStatus = createFetchHandler('system.status', '/system/status');
 *
 * where `createFetchHandler(section, url)` builds its request from `url`. The
 * factory's own api-call carries `${url}`; core substitutes each call site's
 * literal into it (`expandRequestFactories`). Only bare-identifier and member
 * callees with at least one path-shaped literal argument are recorded.
 */
export function extractPathArgCalls(tree: Tree, sourceText: string): PathArgCall[] {
  const urlObjects = moduleUrlObjects(tree.rootNode);
  if (!PATH_ARGUMENT.test(sourceText) && !FORWARD_GATE.test(sourceText) && urlObjects.size === 0) return [];
  const out: PathArgCall[] = [];
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const callee =
      fn?.type === "identifier" ? fn.text : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
    // `fetch(…)`, `axios.get(…)`, `http.post(…)` are requests themselves; a service's own
    // `signedUrlService.fetch(url)` is that object's method, handed a URL (never a verb: `router.post` routes).
    const object = fn?.type === "member_expression" ? fn.childForFieldName("object") : null;
    const ownMethod = !!callee && OBJECT_METHOD.test(callee) && object?.type === "identifier" && !CLIENT_RECEIVER.test(object.text);
    if (!callee || (NOT_A_FACTORY.has(callee.toLowerCase()) && !ownMethod)) continue;
    const argNodes = call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
    // A URL parameter of the enclosing function handed on (`_fetch("POST", url)` inside
    // `_post(url)`) is a hole the wrapper's own call sites fill.
    const forwarded = urlParamsOf(call);
    const args = argNodes.map((a) => literalArg(a) ?? (a.type === "identifier" && forwarded.has(a.text) ? `\${${a.text}}` : urlMember(a, urlObjects)));
    if (!args.some((a) => a !== null && (PATH_SHAPED.test(a) || /^\$\{[\w$]+(?:\.[\w$]+)?\}$/.test(a)))) continue;
    // `send(url, { method: "POST", … })`: the verb the site's options state — or a verb handed positionally (`_fetch("POST", url)`).
    const options = argNodes.find((a) => a.type === "object");
    const positional = args.find((a) => a !== null && VERB.test(a));
    const method = (options ? methodOf(options) : null) ?? (positional ? positional.toUpperCase() : null);
    out.push({ callee, args, line: call.startPosition.row + 1, ...(method ? { method } : {}), ...(ownMethod ? { receiver: object!.text } : {}) });
  }
  return out;
}

/**
 * Module objects of URLs (`const routes = { clubImport: `${prefix}/clubs/import` }`): object → the keys
 * whose value is a path. A call handed `routes.clubImport` is handed that URL.
 */
function moduleUrlObjects(root: Node): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const st of root.namedChildren) {
    const decl = st.type === "export_statement" ? st.namedChildren.find((c) => c.type === "lexical_declaration") : st;
    if (decl?.type !== "lexical_declaration") continue;
    for (const d of decl.namedChildren) {
      const value = d.type === "variable_declarator" ? d.childForFieldName("value") : null;
      const name = d.childForFieldName("name");
      if (value?.type !== "object" || name?.type !== "identifier") continue;
      const keys = new Set<string>();
      for (const pair of value.namedChildren) {
        const v = pair.type === "pair" ? pair.childForFieldName("value") : null;
        if (v && (v.type === "string" || v.type === "template_string") && PATH_SHAPED.test(v.text.slice(1))) keys.add(pair.childForFieldName("key")!.text);
      }
      if (keys.size > 0) out.set(name.text, keys);
    }
  }
  return out;
}

/** `routes.clubImport` of such an object, as the hole the pass reading module values resolves once a wrapper's row is expanded. */
function urlMember(node: Node, objects: ReadonlyMap<string, ReadonlySet<string>>): string | null {
  if (node.type !== "member_expression") return null;
  const object = node.childForFieldName("object");
  const key = node.childForFieldName("property")?.text;
  return object?.type === "identifier" && key && objects.get(object.text)?.has(key) ? `\${${node.text}}` : null;
}

/** Some function hands a URL-named parameter on to another call. */
const FORWARD_GATE = /\b(?:url|uri|path|endpoint|route|href)\b\s*[,)]/;
const URL_PARAM = /^(?:url|uri|path|endpoint|route|href|\w+(?:Url|Uri|Path|Endpoint))$/;

/** The URL-named parameters of the function a call sits in. */
function urlParamsOf(call: Node): Set<string> {
  let fn: Node | null = call.parent;
  while (fn && !/^(?:function_declaration|function_expression|function|arrow_function|method_definition|generator_function_declaration)$/.test(fn.type)) fn = fn.parent;
  const params = fn?.childForFieldName("parameters") ?? fn?.childForFieldName("parameter");
  const out = new Set<string>();
  for (const p of params?.type === "identifier" ? [params] : params?.namedChildren ?? []) {
    const name = p?.type === "identifier" ? p.text : p?.childForFieldName("left")?.text ?? p?.childForFieldName("pattern")?.text;
    if (name && URL_PARAM.test(name)) out.add(name);
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
