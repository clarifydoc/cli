import type { Node, Tree } from "web-tree-sitter";
import type { PathArgCall } from "../../../types/analysis.js";

/**
 * Call sites of a project request wrapper (`FileAnalysis.pathArgCalls`):
 *
 *   class ApiConnection {
 *     public function request(string $requestType, string $endpoint, array $body = []) {
 *       … $client->request($requestType, $endpoint, $param) …     // api-call `{$endpoint}`
 *   }
 *   $connection = new ApiConnection();
 *   $connection->request(Verb::DELETE, "/league/clubs/" . $id);
 *
 * Each call that hands a path to a method is recorded with its arguments
 * (a concatenation's runtime parts as `{}`), the class it is made on — a
 * local built with `new`, a typed parameter or property, `(new X())`, `X::` —
 * and the verb a class-constant or string argument names. The core's
 * request-factory pass joins it to the wrapper's own api-call and fills the
 * wrapper's URL parameter. Calls that are a client's own request
 * (`$client->get('/x')`, `Http::post(…)`) are data sources already.
 */
export function extractPhpPathArgCalls(tree: Tree, sourceText: string): PathArgCall[] {
  if (!/['"][^'"\n]*\/|::(?:GET|POST|PUT|PATCH|DELETE)\b/i.test(sourceText)) return [];
  const out: PathArgCall[] = [];
  for (const call of tree.rootNode.descendantsOfType(["member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"])) {
    if (!call) continue;
    const callee = call.childForFieldName("name")?.text;
    if (!callee) continue;
    const object = call.childForFieldName(call.type === "scoped_call_expression" ? "scope" : "object");
    const objText = object?.text ?? "";
    // A client's own request — the data-source extractor's rows; a URL
    // helper (`$this->makeEndpoint(…)`) builds a URL, it requests nothing.
    if (/Http|Client|Guzzle/i.test(objText) && VERB_METHODS.test(callee)) continue;
    if (ENDPOINT_HELPER.test(callee)) continue;
    const argNodes = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => a?.type === "argument");
    let method: string | undefined;
    const args = argNodes.map((a) => {
      const value = a.namedChildren.find((c) => c?.type !== "name");
      if (!value) return null;
      const verb = verbOf(value);
      if (verb) {
        method ??= verb;
        return null;
      }
      return urlOf(value);
    });
    const pathy = args.some((a) => a !== null && PATH_SHAPED.test(a));
    if (!pathy && !(method && args.some((a) => a !== null))) continue;
    const site: PathArgCall = { callee, args, line: call.startPosition.row + 1 };
    const type = object ? receiverType(object, call) : undefined;
    if (type) site.receiverType = type;
    if (method) site.method = method;
    out.push(site);
  }
  return out;
}

const VERB_METHODS = /^(?:get|post|put|patch|delete|head|options|request|send)$/i;
const VERB_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
/** `/x`, `api/x`, `/x/{}` — a path, not a word. */
const PATH_SHAPED = /^(?:\/[\w{-]|[.]?[\w-]+\/)/;

/** `Verb::DELETE` or `'GET'` → the verb. */
function verbOf(node: Node): string | null {
  if (node.type === "class_constant_access_expression") {
    const name = node.namedChildren[node.namedChildCount - 1]?.text ?? "";
    return VERB_RE.test(name) ? name.toUpperCase() : null;
  }
  if (node.type === "string" || node.type === "encapsed_string") {
    const content = stringContent(node);
    return content !== null && VERB_RE.test(content) ? content.toUpperCase() : null;
  }
  return null;
}

/** A string's text with every interpolation as `{}`; null when not a plain string. */
function stringContent(node: Node): string | null {
  if (node.type !== "string" && node.type !== "encapsed_string") return null;
  let out = "";
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "string_content" || c.type === "string_value") out += c.text;
    else if (c.type === "escape_sequence") out += c.text.slice(1);
    else out += "{}";
  }
  // `'GET'` parses as one string node whose content may not be a named child.
  if (out === "" && node.namedChildCount === 0) out = node.text.replace(/^['"]|['"]$/g, "");
  return out.replace(/(?:\{\})+/g, "{}");
}

/**
 * A URL argument, as far as this file states it: a string; a `.`
 * concatenation with at least one stated part (the others as `{}`); a local
 * the enclosing function assigns one value; a `$this->prop` whose declaration
 * gives it a string; or the URL handed to a `$this->makeEndpoint($request,
 * …)`-style helper — named for an endpoint/URL and handed exactly one — which
 * may only append a query string. Null when nothing is stated.
 */
function urlOf(node: Node, depth = 0): string | null {
  if (depth > 4) return null;
  const direct = stringContent(node);
  if (direct !== null) return direct;
  if (node.type === "parenthesized_expression" && node.namedChildren[0]) return urlOf(node.namedChildren[0], depth + 1);
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === ".") {
    const parts: string[] = [];
    let stated = false;
    const flatten = (n: Node): void => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === ".") {
        for (const side of [n.childForFieldName("left"), n.childForFieldName("right")]) if (side) flatten(side);
        return;
      }
      const v = urlOf(n, depth + 1);
      if (v !== null) {
        parts.push(v);
        stated = true;
      } else parts.push("{}");
    };
    flatten(node);
    return stated ? parts.join("").replace(/(?:\{\})+/g, "{}") : null;
  }
  if (node.type === "variable_name" && node.text !== "$this") return localValue(node, depth);
  if (node.type === "member_access_expression" && node.childForFieldName("object")?.text === "$this") {
    const prop = node.childForFieldName("name")?.text;
    const cls = enclosing(node, CLASS_TYPES);
    const init = prop && cls ? propertyInitializer(cls, prop) : null;
    return init ? urlOf(init, depth + 1) : null;
  }
  if (node.type === "member_call_expression" && node.childForFieldName("object")?.text === "$this" && ENDPOINT_HELPER.test(node.childForFieldName("name")?.text ?? "")) {
    const values = (node.childForFieldName("arguments")?.namedChildren ?? [])
      .map((a) => a?.namedChildren.find((c) => c?.type !== "name"))
      .map((v) => (v ? urlOf(v, depth + 1) : null))
      .filter((v): v is string => v !== null);
    return values.length === 1 ? values[0]! : null;
  }
  return null;
}

/** A helper named for building the URL it is handed (`makeEndpoint`, `buildUrl`, `withPath`). */
const ENDPOINT_HELPER = /^(?:make|build|get|create|with|to)?(?:Api)?(?:End[Pp]oint|Url|Uri|Path)$/i;
const CLASS_TYPES = new Set(["class_declaration", "trait_declaration"]);

/** The one value the enclosing function assigns `$x` before `node` (a parameter or two values: null). */
function localValue(node: Node, depth: number): string | null {
  const fn = enclosing(node, FUNCTION_TYPES);
  if (!fn) return null;
  const values = new Set<string | null>();
  for (const a of fn.descendantsOfType("assignment_expression")) {
    if (!a || a.childForFieldName("left")?.text !== node.text || a.startIndex >= node.startIndex) continue;
    const right = a.childForFieldName("right");
    values.add(right ? urlOf(right, depth + 1) : null);
  }
  return values.size === 1 ? [...values][0]! : null;
}

/** `private $endpoint = "/clubs";` → the initializer node. */
function propertyInitializer(cls: Node, prop: string): Node | null {
  for (const d of cls.descendantsOfType("property_declaration")) {
    for (const el of d?.namedChildren ?? []) {
      if (el?.type !== "property_element") continue;
      const name = el.namedChildren.find((c) => c?.type === "variable_name");
      if (name?.text !== `$${prop}`) continue;
      return el.namedChildren.find((c) => c && c.type !== "variable_name" && c.type !== "property_initializer") ??
        el.namedChildren.find((c) => c?.type === "property_initializer")?.namedChildren[0] ?? null;
    }
  }
  return null;
}

const lastSegment = (name: string): string => name.replace(/^\\/, "").split("\\").pop()!;

/**
 * The class a call is made on, when the source states it: `X::m()` (not
 * `self`/`static`/`parent`), `(new X())->m()`, a variable the enclosing
 * function assigns `new X(…)` or declares as a typed parameter, or
 * `$this->prop` with a typed property or promoted constructor parameter.
 */
function receiverType(object: Node, call: Node): string | undefined {
  if (call.type === "scoped_call_expression") {
    return /^(?:self|static|parent)$/.test(object.text) ? undefined : lastSegment(object.text);
  }
  const inner = object.type === "parenthesized_expression" ? object.namedChildren[0] : object;
  if (inner?.type === "object_creation_expression") {
    const name = inner.namedChildren.find((c) => c?.type === "name" || c?.type === "qualified_name");
    return name ? lastSegment(name.text) : undefined;
  }
  if (inner?.type === "variable_name" && inner.text !== "$this") {
    const fn = enclosing(call, FUNCTION_TYPES);
    return fn ? localType(fn, inner.text) : undefined;
  }
  if (inner?.type === "member_access_expression" && inner.childForFieldName("object")?.text === "$this") {
    const prop = inner.childForFieldName("name")?.text;
    const cls = enclosing(call, CLASS_TYPES);
    return prop && cls ? propertyType(cls, prop) : undefined;
  }
  return undefined;
}

const FUNCTION_TYPES = new Set(["method_declaration", "function_definition", "anonymous_function", "arrow_function"]);

function enclosing(node: Node, types: ReadonlySet<string>): Node | null {
  for (let n = node.parent; n; n = n.parent) if (types.has(n.type)) return n;
  return null;
}

/** `$c = new X(…)` in the function, else its parameter `X $c`. */
function localType(fn: Node, variable: string): string | undefined {
  for (const a of fn.descendantsOfType("assignment_expression")) {
    if (a?.childForFieldName("left")?.text !== variable) continue;
    const right = a.childForFieldName("right");
    if (right?.type !== "object_creation_expression") continue;
    const name = right.namedChildren.find((c) => c?.type === "name" || c?.type === "qualified_name");
    if (name) return lastSegment(name.text);
  }
  return paramType(fn.childForFieldName("parameters"), variable);
}

function paramType(params: Node | null, variable: string): string | undefined {
  for (const p of params?.namedChildren ?? []) {
    if (!p || (p.type !== "simple_parameter" && p.type !== "property_promotion_parameter")) continue;
    if (p.childForFieldName("name")?.text !== variable) continue;
    const type = p.childForFieldName("type")?.text;
    return type && /^\??\\?[A-Z][\w\\]*$/.test(type) ? lastSegment(type.replace(/^\?/, "")) : undefined;
  }
  return undefined;
}

/** `private X $prop;`, or a constructor's promoted `private X $prop`. */
function propertyType(cls: Node, prop: string): string | undefined {
  for (const d of cls.descendantsOfType("property_declaration")) {
    if (!d?.namedChildren.some((c) => c?.type === "property_element" && c.text.replace(/\s*=.*$/s, "") === `$${prop}`)) continue;
    const type = d.childForFieldName("type")?.text;
    return type && /^\??\\?[A-Z][\w\\]*$/.test(type) ? lastSegment(type.replace(/^\?/, "")) : undefined;
  }
  const ctor = cls.descendantsOfType("method_declaration").find((m) => m?.childForFieldName("name")?.text === "__construct");
  return ctor ? paramType(ctor.childForFieldName("parameters"), `$${prop}`) : undefined;
}
