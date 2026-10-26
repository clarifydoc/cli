import type { Node } from "web-tree-sitter";
import type { CallArgOrigin } from "../../../types/analysis.js";

/**
 * Where a call's arguments come from (`CallInfo.argOrigins`), for the
 * `paramOrigins` project pass that follows an API call's URL slot back to the
 * screen: a literal, a parameter of an enclosing function, or a value the
 * router reads off the current URL —
 *
 *   React Router  `useParams().id`, `const { id } = useParams()`, `this.props.match.params.id`
 *   Vue Router    `useRoute().params.id`, `route.params.id` (`route = useRoute()`), `this.$route.params.id`
 *   Next.js       `useRouter().query.id`, `useParams()`, `useSearchParams().get("q")` (a query value)
 *   Angular       `route.snapshot.params.id`, `route.snapshot.paramMap.get("id")`
 *
 * A query-string read is its own kind (`query-param`), never a route
 * parameter. One wrapper is unwrapped and named (`Number(id)`,
 * `encodeURIComponent(slug)`, `` `${id}` ``, `id!`, `id as string`).
 * Reported only when at least one argument's origin is known.
 */
export function argOriginsOf(node: Node): CallArgOrigin[] | null {
  if (node.type !== "call_expression" && node.type !== "new_expression") return null;
  const args = node.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  if (args.length === 0 || args.length > 8 || args.some((a) => a.type === "spread_element")) return null;
  const out: CallArgOrigin[] = [];
  args.forEach((arg, index) => {
    if (arg.type === "object") {
      fieldOrigins(arg, index, "", 0, out);
      return;
    }
    const { node: value, transform } = unwrap(arg);
    const origin = originOf(value, 0);
    if (origin) out.push({ index, origin, ...(transform ? { transform } : {}) });
  });
  // Literals alone say nothing a URL slot needs: kept only beside a parameter or a URL value.
  return out.some((a) => a.origin.kind !== "literal") ? out : null;
}

/** The keys of a request-options object that carry URL values: hey-api's `path`/`query`, openapi-fetch's `params`. */
const URL_VALUE_KEYS = new Set(["path", "query", "params"]);

/**
 * The properties of an object-literal argument whose value is known, by dotted
 * path, under the keys a generated SDK takes its URL values from
 * (`getClub({ path: { id } })`, `client.GET(url, { params: { path: { id } } })`).
 */
function fieldOrigins(obj: Node, index: number, prefix: string, depth: number, out: CallArgOrigin[]): void {
  if (depth > 2) return;
  for (const prop of obj.namedChildren) {
    if (!prop) continue;
    if (depth === 0) {
      // Only the URL-value objects: other options (`body`, `headers`, a payload) feed no URL slot.
      const key = prop.type === "pair" ? prop.childForFieldName("key") : null;
      const value = prop.type === "pair" ? prop.childForFieldName("value") : null;
      const name = key?.type === "property_identifier" ? key.text : stringValue(key);
      if (name && URL_VALUE_KEYS.has(name) && value?.type === "object") fieldOrigins(value, index, `${name}.`, 1, out);
      continue;
    }
    if (prop.type === "shorthand_property_identifier") {
      const origin = identifierOrigin(prop, prop.text, 0);
      if (origin) out.push({ index, origin, field: prefix + prop.text });
      continue;
    }
    if (prop.type !== "pair") continue;
    const key = prop.childForFieldName("key");
    const keyText = key?.type === "property_identifier" ? key.text : stringValue(key);
    const raw = prop.childForFieldName("value");
    if (!keyText || !/^[\w$]+$/.test(keyText) || !raw) continue;
    if (raw.type === "object") {
      fieldOrigins(raw, index, `${prefix}${keyText}.`, depth + 1, out);
      continue;
    }
    const { node: value, transform } = unwrap(raw);
    const origin = originOf(value, 0);
    if (origin) out.push({ index, origin, field: prefix + keyText, ...(transform ? { transform } : {}) });
  }
}

/** A file that reads no URL values needs no declaration scan: the router's words, once per tree. */
const READS_URL = new WeakMap<object, boolean>();
const URL_WORDS = /params|query|\$route|paramMap|useParams|useRoute|useSearchParams/;
function readsUrl(n: Node): boolean {
  const tree = n.tree as unknown as object;
  let hit = READS_URL.get(tree);
  if (hit === undefined) {
    hit = URL_WORDS.test(n.tree.rootNode.text);
    READS_URL.set(tree, hit);
  }
  return hit;
}

const WRAPPERS = new Set(["Number", "String", "parseInt", "parseFloat", "encodeURIComponent", "encodeURI", "BigInt"]);

/** One wrapper around the value, and its name. */
function unwrap(n: Node): { node: Node; transform?: string } {
  let node = n;
  let transform: string | undefined;
  for (let i = 0; i < 4; i++) {
    if (node.type === "parenthesized_expression" || node.type === "non_null_expression" || node.type === "as_expression" || node.type === "satisfies_expression") {
      node = node.namedChild(0) ?? node;
      continue;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const inner = node.childForFieldName("arguments")?.namedChildren.filter((a) => a?.type !== "comment") ?? [];
      if (fn?.type === "identifier" && WRAPPERS.has(fn.text) && inner.length >= 1) {
        transform ??= fn.text;
        node = inner[0]!;
        continue;
      }
      // Vue's reactive wrappers: `computed(() => Number(route.params.id))`, `ref(id)`, `toRef(…)`.
      if (fn?.type === "identifier" && (fn.text === "computed" || fn.text === "ref" || fn.text === "toRef" || fn.text === "unref") && inner.length === 1) {
        const body = inner[0]!.type === "arrow_function" ? inner[0]!.childForFieldName("body") : inner[0]!;
        if (body && body.type !== "statement_block") {
          transform ??= fn.text;
          node = body;
          continue;
        }
      }
    }
    if (node.type === "template_string") {
      const subs = node.namedChildren.filter((c) => c?.type === "template_substitution");
      const text = node.namedChildren.filter((c) => c?.type === "string_fragment");
      if (subs.length === 1 && text.length === 0) {
        transform ??= "template";
        node = subs[0]!.namedChild(0) ?? node;
        continue;
      }
    }
    break;
  }
  return { node, ...(transform ? { transform } : {}) };
}

type Origin = CallArgOrigin["origin"];

function originOf(n: Node, depth: number): Origin | null {
  if (depth > 4) return null;
  switch (n.type) {
    case "string": {
      const text = n.namedChildren.filter((c) => c?.type === "string_fragment").map((c) => c!.text).join("");
      return { kind: "literal", value: text };
    }
    case "number":
      return { kind: "literal", value: n.text };
    case "template_string": {
      if (n.namedChildren.some((c) => c?.type === "template_substitution")) return null;
      return { kind: "literal", value: n.namedChildren.map((c) => c!.text).join("") };
    }
    case "member_expression":
    case "subscript_expression": {
      // `clubId.value`, where `clubId = computed(() => route.params.id)`: the reactive wrapper's value.
      const obj = n.childForFieldName("object");
      if (n.type === "member_expression" && n.childForFieldName("property")?.text === "value" && obj?.type === "identifier" && readsUrl(n)) {
        const bound = paramOf(obj, obj.text) ? null : bindingOf(obj, obj.text);
        if (bound?.kind === "value") return originOf(unwrap(bound.value).node, depth + 1);
      }
      return paramRead(n, depth);
    }
    case "call_expression": {
      // `searchParams.get("q")`, `route.snapshot.paramMap.get("id")`.
      const fn = n.childForFieldName("function");
      const key = literalArg(n);
      if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "get" && key) {
        const obj = fn.childForFieldName("object")!;
        const kind = paramsObject(obj, depth + 1);
        if (kind) return { kind, name: key };
        if (obj.type === "member_expression" && obj.childForFieldName("property")?.text === "paramMap") return { kind: "route-param", name: key };
        if (obj.type === "member_expression" && obj.childForFieldName("property")?.text === "queryParamMap") return { kind: "query-param", name: key };
      }
      return null;
    }
    case "identifier":
      return identifierOrigin(n, n.text, depth);
  }
  return null;
}

/** A name read at `n`: a parameter of an enclosing function, or a local the router fills. */
function identifierOrigin(n: Node, name: string, depth: number): Origin | null {
  const param = paramOf(n, name);
  if (param) return param;
  if (!readsUrl(n)) return null;
  const bound = bindingOf(n, name);
  if (!bound) return null;
  if (bound.kind === "value") return originOf(unwrap(bound.value).node, depth + 1);
  // `const { id } = useParams()` / `const { id: clubId } = this.props.match.params`
  const kind = paramsObject(bound.value, depth + 1);
  return kind ? { kind, name: bound.key } : null;
}

/** `params.id` / `params["id"]` where `params` is a params object of the router. */
function paramRead(n: Node, depth: number): Origin | null {
  const obj = n.childForFieldName("object");
  if (!obj) return null;
  const key = n.type === "member_expression"
    ? n.childForFieldName("property")?.text
    : stringValue(n.childForFieldName("index"));
  if (!key || !/^[\w$-]+$/.test(key)) return null;
  const kind = paramsObject(obj, depth + 1);
  return kind ? { kind, name: key } : null;
}

/**
 * Is `n` an object the router fills with the URL's values — and which:
 * route parameters or the query string?
 */
function paramsObject(n: Node, depth: number): "route-param" | "query-param" | null {
  if (depth > 6) return null;
  const text = n.text.replace(/\s+/g, "");
  if (/^(?:this\.)?(?:props\.)?match\.params$/.test(text) || /^(?:this\.)?\$route\.params$/.test(text) || /^(?:this\.)?(?:route|activatedRoute|activeRoute)\.snapshot\.params$/.test(text)) return "route-param";
  if (/^(?:this\.)?\$route\.query$/.test(text) || /^(?:this\.)?(?:route|activatedRoute|activeRoute)\.snapshot\.queryParams$/.test(text)) return "query-param";
  if (n.type === "call_expression") {
    const fn = n.childForFieldName("function")?.text;
    if (fn === "useParams" || fn === "useLocalSearchParams") return "route-param";
    if (fn === "useSearchParams") return "query-param";
    return null;
  }
  if (n.type === "member_expression") {
    const prop = n.childForFieldName("property")?.text;
    const owner = n.childForFieldName("object")!;
    if (prop === "params" && routeObject(owner, depth + 1)) return "route-param";
    if (prop === "query" && (routeObject(owner, depth + 1) || routerObject(owner))) return "query-param";
    return null;
  }
  if (n.type === "identifier") {
    if (paramOf(n, n.text)) return null;
    const bound = bindingOf(n, n.text);
    if (!bound) return null;
    if (bound.kind === "value") return paramsObject(unwrap(bound.value).node, depth + 1);
    // `const { params } = useRoute()` / `const { query } = useRouter()`
    if (bound.key === "params" && routeObject(bound.value, depth + 1)) return "route-param";
    if (bound.key === "query" && (routeObject(bound.value, depth + 1) || routerObject(bound.value))) return "query-param";
    if (bound.key === "params" && /^(?:this\.)?(?:props\.)?match$/.test(bound.value.text)) return "route-param";
  }
  return null;
}

/** `useRoute()`, `this.$route`, or a local holding one. */
function routeObject(n: Node, depth: number): boolean {
  if (depth > 6) return false;
  if (n.type === "call_expression") return n.childForFieldName("function")?.text === "useRoute";
  if (/^(?:this\.)?\$route$/.test(n.text)) return true;
  if (n.type === "identifier" && !paramOf(n, n.text)) {
    const bound = bindingOf(n, n.text);
    return !!bound && bound.kind === "value" && routeObject(unwrap(bound.value).node, depth + 1);
  }
  return false;
}

/** Next.js pages `useRouter()` (its `query` is the URL's values). */
function routerObject(n: Node): boolean {
  if (n.type === "call_expression") return n.childForFieldName("function")?.text === "useRouter";
  if (n.type === "identifier" && !paramOf(n, n.text)) {
    const bound = bindingOf(n, n.text);
    return !!bound && bound.kind === "value" && unwrap(bound.value).node.type === "call_expression" && unwrap(bound.value).node.childForFieldName("function")?.text === "useRouter";
  }
  return false;
}

const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition"]);
const SCOPE_NODES = new Set(["statement_block", "program", "class_body"]);

/** `name` as a parameter of the innermost enclosing function that declares it. */
function paramOf(at: Node, name: string): Origin | null {
  for (let fn: Node | null = at.parent; fn; fn = fn.parent) {
    if (!FUNCTION_NODES.has(fn.type)) continue;
    const single = fn.childForFieldName("parameter");
    if (single?.type === "identifier") {
      if (single.text === name) return { kind: "param", name, index: 0 };
      continue;
    }
    const params = fn.childForFieldName("parameters")?.namedChildren.filter((p) => p?.type !== "comment") ?? [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const pattern = p.childForFieldName("pattern") ?? p;
      const id = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
      if (id?.type === "identifier" && id.text === name) return { kind: "param", name, index: i };
      if (declares(pattern, name)) return null; // bound by a destructured parameter: not a plain argument
    }
  }
  return null;
}

function declares(pattern: Node | null, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") return pattern.text === name;
  return pattern.namedChildren.some((c) => !!c && c.type !== "property_identifier" && declares(c, name));
}

/**
 * Where `name` is declared in a scope around `at` (the nearest one): its
 * initializer (`kind: "value"`), or the object it is destructured from and
 * the key it takes (`kind: "member"`).
 */
function bindingOf(at: Node, name: string): { kind: "value"; value: Node } | { kind: "member"; key: string; value: Node } | null {
  for (let scope: Node | null = at.parent; scope; scope = scope.parent) {
    if (!SCOPE_NODES.has(scope.type)) continue;
    for (const stmt of scope.namedChildren) {
      const decl = stmt?.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
      if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
      for (const d of decl.namedChildren) {
        if (d?.type !== "variable_declarator") continue;
        const target = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (!target || !value) continue;
        if (target.type === "identifier" && target.text === name) return { kind: "value", value };
        // `const [searchParams] = useSearchParams()`: the hook's first element stands for the hook.
        if (target.type === "array_pattern" && target.namedChildren[0]?.type === "identifier" && target.namedChildren[0].text === name) return { kind: "value", value };
        if (target.type === "object_pattern") {
          for (const prop of target.namedChildren) {
            if (prop?.type === "shorthand_property_identifier_pattern" && prop.text === name) return { kind: "member", key: name, value };
            if (prop?.type === "pair_pattern") {
              const local = prop.childForFieldName("value");
              const local2 = local?.type === "assignment_pattern" ? local.childForFieldName("left") : local;
              if (local2?.type === "identifier" && local2.text === name) return { kind: "member", key: prop.childForFieldName("key")?.text ?? name, value };
            }
            if (prop?.type === "object_assignment_pattern") {
              const left = prop.childForFieldName("left");
              if (left?.text === name) return { kind: "member", key: name, value };
            }
          }
        }
      }
    }
  }
  return null;
}

function stringValue(n: Node | null): string | null {
  if (n?.type !== "string") return null;
  return n.namedChildren.filter((c) => c?.type === "string_fragment").map((c) => c!.text).join("");
}

function literalArg(call: Node): string | null {
  const first = call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment");
  return first ? stringValue(first) : null;
}
