import type { Node } from "web-tree-sitter";
import type { CallArgOrigin, ValueStep } from "../../../types/analysis.js";

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
 * `encodeURIComponent(slug)`, `` `${id}` ``, `id!`, `id as string`; a getter
 * `() => props.clubId` handed to a composable that reads it with `toValue`).
 * A value derived from a known one says how (`derivation`): read off a
 * collection it keys (`clubStore.clubs[props.clubId].id`), or returned by a
 * function called with it and literals only (`getSeasonIdFromClubId(props.clubId)`),
 * or a member of what a composable returns for it (`const { club } =
 * useClub(() => props.clubId)` … `club.value.id`; the project pass follows it
 * only where the composable states how the member derives from that parameter,
 * `derivedLocalsOf`). A `watch` callback's first parameter is the watched
 * value (`watch(() => props.clubId, (id) => …)`).
 * Reported only when at least one argument's origin is known.
 */
export function argOriginsOf(node: Node): CallArgOrigin[] | null {
  if (node.type !== "call_expression" && node.type !== "new_expression") return null;
  const args = node.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  if (args.length === 0 || args.length > 8 || args.some((a) => a.type === "spread_element")) return null;
  const out: CallArgOrigin[] = [];
  // `mutation.mutate({ clubId, name })`: every property is what the callback receives.
  const callee = node.childForFieldName("function");
  const invokes = callee?.type === "member_expression" && INVOKER_METHODS.has(callee.childForFieldName("property")?.text ?? "");
  args.forEach((arg, index) => {
    if (arg.type === "object") {
      fieldOrigins(arg, index, "", invokes ? 1 : 0, out);
      return;
    }
    // `useSquad(() => props.clubId)`: a getter the composable reads with `toValue`.
    const getter = getterBody(arg);
    const { node: value, transform } = getter ? { node: unwrap(getter).node, transform: "getter" } : unwrap(arg);
    const found = originOf(value, 0);
    if (found) out.push({ index, ...split(found), ...(transform ? { transform } : {}) });
  });
  // Literals alone say nothing a URL slot needs: kept only beside a parameter or a URL value.
  return out.some((a) => a.origin.kind !== "literal") ? out : null;
}

/** A found origin as an argument's: the origin, and the steps it was derived by. */
function split(found: Found): { origin: Origin; derivation?: ValueStep[] } {
  const { steps, ...origin } = found;
  return { origin: origin as Origin, ...(steps?.length ? { derivation: steps } : {}) };
}

/** The body of a getter argument — an arrow with no parameters returning an expression (`() => props.clubId`). */
function getterBody(arg: Node): Node | null {
  if (arg.type !== "arrow_function" || arg.childForFieldName("parameter")) return null;
  if ((arg.childForFieldName("parameters")?.namedChildren.filter((p) => p?.type !== "comment").length ?? 0) > 0) return null;
  const body = arg.childForFieldName("body");
  return body && body.type !== "statement_block" ? body : null;
}

/**
 * Callbacks a library calls with what its caller hands one of its methods:
 * TanStack Query's `mutationFn`, called with `mutation.mutate(x)` /
 * `mutateAsync(x)`'s argument. A parameter of such a callback is that
 * argument (`kind: "invoked"`), followed by the project pass to each call.
 */
const INVOKED_CALLBACKS: ReadonlyMap<string, string[]> = new Map([["mutationFn", ["mutate", "mutateAsync"]]]);
const INVOKER_METHODS = new Set([...INVOKED_CALLBACKS.values()].flat());

/** The methods whose argument `fn` is called with, when it is an invoked callback (`mutationFn: (x) => …`). */
function invokerOf(fn: Node): string[] | undefined {
  const pair = fn.parent;
  if (pair?.type !== "pair" || pair.childForFieldName("value")?.id !== fn.id) return undefined;
  const key = pair.childForFieldName("key");
  return INVOKED_CALLBACKS.get(key?.type === "property_identifier" ? key.text : stringValue(key) ?? "");
}

/** Where `name` sits in a destructuring pattern: `{ id }` → `id`, `{ path: { id: clubId } }` → `path.id` (for `clubId`). */
function fieldPath(pattern: Node, name: string, prefix = ""): string | null {
  for (const prop of pattern.namedChildren) {
    if (!prop) continue;
    if (prop.type === "shorthand_property_identifier_pattern" && prop.text === name) return prefix + name;
    if (prop.type === "object_assignment_pattern" && prop.childForFieldName("left")?.text === name) return prefix + name;
    if (prop.type === "pair_pattern") {
      const key = prop.childForFieldName("key")?.text;
      let value = prop.childForFieldName("value");
      if (value?.type === "assignment_pattern") value = value.childForFieldName("left");
      if (!key || !value) continue;
      if (value.type === "identifier" && value.text === name) return prefix + key;
      if (value.type === "object_pattern") {
        const inner = fieldPath(value, name, `${prefix}${key}.`);
        if (inner) return inner;
      }
    }
  }
  return null;
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
    // `mutateAsync({ ...club.value, archived: true })`: the record spread in stands for the properties it holds.
    if (prop.type === "spread_element") {
      const inner = prop.namedChildren.find((c) => c?.type !== "comment");
      const found = !prefix && inner ? originOf(unwrap(inner).node, 0) : null;
      if (found && wholeRecord(found.steps)) {
        // What an earlier property set, the spread may overwrite.
        for (let i = out.length - 1; i >= 0; i--) if (out[i]!.index === index) out.splice(i, 1);
        out.push({ index, ...split(found) });
      }
      continue;
    }
    if (prop.type === "shorthand_property_identifier") {
      const found = identifierOrigin(prop, prop.text, 0);
      if (found) out.push({ index, ...split(found), field: prefix + prop.text });
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
    const found = originOf(value, 0);
    if (found) out.push({ index, ...split(found), field: prefix + keyText, ...(transform ? { transform } : {}) });
  }
}

/**
 * The fields a data statement's filter object compares with a value whose
 * origin is known (`{ username: name }`, `{ slug }`, `{ author: { id } }` →
 * `author.id`), literals left out. Null when there is none.
 */
export function filterOrigins(obj: Node): Array<{ field: string; origin: Origin; transform?: string }> | null {
  const out: CallArgOrigin[] = [];
  fieldOrigins(obj, 0, "", 1, out);
  // A value derived from a request value (a lookup, a helper's result) is not the value a filter compares.
  const known = out.filter((o) => o.origin.kind !== "literal" && o.field && !o.derivation);
  return known.length > 0 ? known.map((o) => ({ field: o.field!, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) })) : null;
}

/** A file that reads no URL values needs no declaration scan: the router's words, once per tree. */
const READS_URL = new WeakMap<object, boolean>();
const URL_WORDS = /params|query|\$route|paramMap|useParams|useRoute|useSearchParams|props|defineProps/;
/** Set while a composable's returned locals are read (`derivedLocalsOf`): its parameters are the values, not the URL. */
let readingLocals = 0;
function readsUrl(n: Node): boolean {
  if (readingLocals > 0) return true;
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
export function unwrap(n: Node): { node: Node; transform?: string } {
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
      // Vue's reactive wrappers: `computed(() => Number(route.params.id))`, `ref(id)`, `toRef(…)`, `toValue(clubId)`.
      if (fn?.type === "identifier" && (fn.text === "computed" || fn.text === "ref" || fn.text === "toRef" || fn.text === "unref" || fn.text === "toValue") && inner.length === 1) {
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
/** An origin, and the steps the value at hand was derived from it by (`CallArgOrigin.derivation`). */
type Found = Origin & { steps?: ValueStep[] };

function originOf(n: Node, depth: number): Found | null {
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
        if (bound?.kind === "value") {
          // `ref(0)` is state the component changes: its first value is no origin.
          const held = unwrap(bound.value);
          const origin = originOf(held.node, depth + 1);
          return origin?.kind === "literal" && held.transform === "ref" ? null : origin;
        }
        // `const { clubId } = toRefs(props)` … `clubId.value`: the prop.
        if (bound?.kind === "member" && propsSource(unwrap(bound.value).node, depth + 1)) return { kind: "prop", name: bound.key };
      }
      // `label.id` on an invoked callback's parameter: that property of what the invoker is handed.
      const prop = n.childForFieldName("property")?.text;
      if (n.type === "member_expression" && obj?.type === "identifier" && prop && /^[\w$]+$/.test(prop)) {
        const param = paramOf(obj, obj.text);
        if (param?.kind === "invoked") return { ...param, field: param.field ? `${param.field}.${prop}` : prop };
      }
      // `props.clubId`: a prop of the component the read sits in.
      if (n.type === "member_expression" && obj && prop && /^[\w$]+$/.test(prop) && readsUrl(n) && propsObject(obj, depth + 1)) return { kind: "prop", name: prop };
      const direct = paramRead(n, depth);
      if (direct || !obj) return direct;
      // `clubStore.clubs[props.clubId]`: the key, read off the collection.
      if (n.type === "subscript_expression") return lookupOf(n, obj, depth);
      if (prop && /^[\w$]+$/.test(prop) && readsUrl(n)) {
        // `clubState.club`, `clubState = useClub(() => props.clubId)`: a member of what a composable returns for the value.
        const held = obj.type === "identifier" && !paramOf(obj, obj.text) ? bindingOf(obj, obj.text) : null;
        const member = held?.kind === "value" ? returnedMemberOf(unwrap(held.value).node, prop, depth) : null;
        if (member) return member;
        // `club.value.id`, `club.id`: a property of what a known value looked up.
        return readOffLookup(originOf(obj, depth + 1), prop);
      }
      return null;
    }
    case "call_expression": {
      // `searchParams.get("q")`, `route.snapshot.paramMap.get("id")`.
      const fn = n.childForFieldName("function");
      // `toRef(props, "clubId")`: that prop.
      if (fn?.type === "identifier" && fn.text === "toRef") {
        const [of, key] = n.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
        const name = stringValue(key ?? null);
        if (of && name && propsObject(of, depth + 1)) return { kind: "prop", name };
      }
      const key = literalArg(n);
      if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "get" && key) {
        const obj = fn.childForFieldName("object")!;
        const kind = paramsObject(obj, depth + 1);
        if (kind) return { kind, name: key };
        if (obj.type === "member_expression" && obj.childForFieldName("property")?.text === "paramMap") return { kind: "route-param", name: key };
        if (obj.type === "member_expression" && obj.childForFieldName("property")?.text === "queryParamMap") return { kind: "query-param", name: key };
      }
      // `getSeasonIdFromClubId(props.clubId)`: what a function returns for the value.
      if (fn?.type === "identifier") return helperOf(n, fn.text, depth);
      return null;
    }
    case "identifier":
      return identifierOrigin(n, n.text, depth);
  }
  return null;
}

/**
 * `obj[key]` where the key's origin is known and `obj` is a member chain
 * (`clubStore.clubs[props.clubId]`): the key's origin, read off that
 * collection — and the call the chain's head holds (`useClubStore()`), the store.
 */
function lookupOf(n: Node, obj: Node, depth: number): Found | null {
  const index = n.childForFieldName("index");
  const object = obj.text.replace(/\s+/g, "").replace(/\?\.$/, "").replace(/\?\./g, ".");
  if (!index || !/^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(object) || !readsUrl(n)) return null;
  if (paramsObject(obj, depth + 1) || propsObject(obj, depth + 1)) return null;
  const key = originOf(unwrap(index).node, depth + 1);
  if (!key || key.kind === "literal") return null;
  const head = object.startsWith("this.") ? null : object.split(".")[0]!;
  const bound = head && head !== object && !paramOf(n, head) ? bindingOf(n, head) : null;
  const held = bound?.kind === "value" ? unwrap(bound.value).node : null;
  const factory = held?.type === "call_expression" ? held.childForFieldName("function") : null;
  const from = factory?.type === "identifier" ? { from: factory.text, fromLine: held!.startPosition.row + 1 } : {};
  return { ...key, steps: [...(key.steps ?? []), { kind: "lookup", object, line: n.startPosition.row + 1, ...from }] };
}

/**
 * Property `prop` of a record a lookup found (`club.value.id`), or of a
 * composable's member (`club.value.id`, `const { club } = useClub(…)`): the
 * step's field. Null for anything else.
 */
function readOffLookup(base: Found | null, prop: string): Found | null {
  const last = base?.steps?.[base.steps.length - 1];
  if (!base || (last?.kind !== "lookup" && last?.kind !== "returned")) return null;
  return { ...base, steps: [...base.steps!.slice(0, -1), { ...last, field: last.field ? `${last.field}.${prop}` : prop }] };
}

/**
 * `helper(value, "literal", …)`: one argument of known origin, the others
 * literals — the function's result derives from that value. Wrappers
 * (`Number`, `encodeURIComponent`) are unwrapped before this.
 */
function helperOf(n: Node, name: string, depth: number): Found | null {
  if (WRAPPERS.has(name) || name === "defineProps" || name === "withDefaults") return null;
  const args = n.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  if (args.length === 0 || args.length > 4 || !readsUrl(n)) return null;
  let found: { index: number; origin: Found } | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.type === "spread_element") return null;
    const origin = originOf(unwrap(args[i]!).node, depth + 1);
    if (!origin) return null;
    if (origin.kind === "literal") continue;
    if (found) return null;
    found = { index: i, origin };
  }
  if (!found) return null;
  return { ...found.origin, steps: [...(found.origin.steps ?? []), { kind: "helper", name, line: n.startPosition.row + 1, index: found.index }] };
}

/** A name read at `n`: a parameter of an enclosing function, or a local the router fills. */
function identifierOrigin(n: Node, name: string, depth: number): Found | null {
  const param = paramOf(n, name);
  if (param) return param;
  if (!readsUrl(n)) return null;
  const bound = bindingOf(n, name);
  if (!bound) return null;
  if (bound.kind === "value") return originOf(unwrap(bound.value).node, depth + 1);
  // `const { clubId } = defineProps<…>()`, `= toRefs(props)`, `= props`: the prop.
  if (propsSource(unwrap(bound.value).node, depth + 1)) return { kind: "prop", name: bound.key };
  // `const { id } = useParams()` / `const { id: clubId } = this.props.match.params`
  const kind = paramsObject(bound.value, depth + 1);
  if (kind) return { kind, name: bound.key };
  // `const { club } = useClub(() => props.clubId)`: a member of what the composable returns for the value.
  return returnedMemberOf(unwrap(bound.value).node, bound.key, depth);
}

/** Calls whose result is the router's, the props' or a wrapper's, never a composable's for a value. */
const NOT_COMPOSABLES = new Set(["defineProps", "withDefaults", "toRefs", "toRef", "storeToRefs", "useRoute", "useRouter", "useParams", "useSearchParams", "useLocalSearchParams", "reactive", "readonly"]);

/**
 * `useClub(() => props.clubId)` read for its member `key`: one argument
 * (a getter's body, or the value itself) has a known origin that is no
 * literal — the member derives from it, if the composable says so
 * (`FunctionInfo.derivedLocals`, checked by the project pass). The other
 * arguments may be anything: the composable states which parameter the
 * member is keyed by.
 */
function returnedMemberOf(call: Node, key: string, depth: number): Found | null {
  if (call.type !== "call_expression" || depth > 4) return null;
  const fn = call.childForFieldName("function");
  if (fn?.type !== "identifier" || WRAPPERS.has(fn.text) || NOT_COMPOSABLES.has(fn.text)) return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  if (args.length === 0 || args.length > 4 || !readsUrl(call)) return null;
  let found: { index: number; origin: Found } | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.type === "spread_element") return null;
    const origin = originOf(unwrap(getterBody(args[i]!) ?? args[i]!).node, depth + 1);
    if (!origin || origin.kind === "literal") continue;
    if (found) return null;
    found = { index: i, origin };
  }
  if (!found) return null;
  return { ...found.origin, steps: [...(found.origin.steps ?? []), { kind: "returned", name: fn.text, line: call.startPosition.row + 1, index: found.index, key }] };
}

/** A derivation ending in a whole record: looked up with no property read, or a composable's member (or its ref's `.value`). */
function wholeRecord(steps: readonly ValueStep[] | undefined): boolean {
  const last = steps?.[steps.length - 1];
  return (last?.kind === "lookup" && !last.field) || (last?.kind === "returned" && (!last.field || last.field === "value"));
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
    if (prop === "params" && (routeObject(owner, depth + 1) || requestObject(owner))) return "route-param";
    if (prop === "query" && (routeObject(owner, depth + 1) || routerObject(owner) || requestObject(owner))) return "query-param";
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

/**
 * A server handler's request (its `params` are the matched route's, its `query`
 * the request's query string): a parameter of an enclosing function named
 * `req`/`request` (Express, Fastify), Koa's `ctx`, or one typed as a request
 * (`(r: FastifyRequest) =>`, `NextApiRequest`).
 */
function requestObject(n: Node): boolean {
  if (n.type !== "identifier") return false;
  for (let fn: Node | null = n.parent; fn; fn = fn.parent) {
    if (!FUNCTION_NODES.has(fn.type)) continue;
    const single = fn.childForFieldName("parameter");
    const params = single ? [single] : fn.childForFieldName("parameters")?.namedChildren.filter((p): p is Node => !!p && p.type !== "comment") ?? [];
    for (const p of params) {
      const id = p.childForFieldName("pattern") ?? p;
      if (id.type !== "identifier" || id.text !== n.text) continue;
      if (/^(?:req|request|ctx)$/.test(n.text)) return true;
      const type = p.childForFieldName("type")?.text.replace(/^:\s*/, "") ?? "";
      return /^(?:\w+\.)?\w*Request\b/.test(type);
    }
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

/**
 * `name` as a parameter of the innermost enclosing function that declares it —
 * or, where that function is a callback a library invokes (`mutationFn`), the
 * argument (or the property of it the callback destructures) its invoker is handed.
 */
function paramOf(at: Node, name: string): Found | null {
  for (let fn: Node | null = at.parent; fn; fn = fn.parent) {
    if (!FUNCTION_NODES.has(fn.type)) continue;
    const single = fn.childForFieldName("parameter");
    if (single?.type === "identifier") {
      if (single.text === name) {
        const via = invokerOf(fn);
        return via ? { kind: "invoked", via, index: 0 } : watchedValue(fn) ?? { kind: "param", name, index: 0 };
      }
      continue;
    }
    const params = fn.childForFieldName("parameters")?.namedChildren.filter((p) => p?.type !== "comment") ?? [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const pattern = p.childForFieldName("pattern") ?? p;
      const id = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
      if (id?.type === "identifier" && id.text === name) {
        const via = invokerOf(fn);
        return via ? { kind: "invoked", via, index: i } : (i === 0 ? watchedValue(fn) : null) ?? { kind: "param", name, index: i };
      }
      if (declares(pattern, name)) {
        // `watch([() => props.clubId, query.data], ([id, value]) => …)`: an element of the watched values.
        const element = i === 0 && id?.type === "array_pattern" ? id.namedChildren.filter((c) => c?.type !== "comment").findIndex((c) => c?.type === "identifier" && c.text === name) : -1;
        if (element >= 0) return watchedValue(fn, element);
        // A component's destructured props (`function ClubCard({ clubId })`): the prop.
        if (i === 0 && id?.type === "object_pattern" && isComponentFunction(fn)) {
          const field = fieldPath(id, name);
          return field && !field.includes(".") ? { kind: "prop", name: field } : null;
        }
        // Bound by a destructured parameter: not a plain argument — unless a library hands it in.
        const via = invokerOf(fn);
        const field = via && id?.type === "object_pattern" ? fieldPath(id, name) : null;
        return via && field ? { kind: "invoked", via, index: i, field } : null;
      }
    }
  }
  return null;
}

let watching = 0;
const VUE_WATCH = new WeakMap<object, boolean>();
/** Whether a bare `watch` in this file is Vue's: imported from Vue (or a Vue toolkit), or auto-imported — never `fs`'s or a file watcher's. */
function vueWatch(n: Node): boolean {
  const tree = n.tree as unknown as object;
  let vue = VUE_WATCH.get(tree);
  if (vue === undefined) {
    const from = /import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["']([^"']+)["']/.exec(n.tree.rootNode.text)?.[1];
    vue = from === undefined || /^(?:vue|vue-demi|@vue\/|@vueuse\/|#imports|nuxt)/.test(from);
    VUE_WATCH.set(tree, vue);
  }
  return vue;
}
/**
 * `watch(source, (value) => …)`: the callback's first parameter is the watched
 * value — where the source's comes from (a getter's body, or a ref); with
 * `element`, the parameter destructures an array of sources and takes that
 * one. Null for any other function, or a source of unknown origin.
 */
function watchedValue(fn: Node, element?: number): Found | null {
  const args = fn.parent;
  const call = args?.type === "arguments" ? args.parent : null;
  if (call?.type !== "call_expression" || call.childForFieldName("function")?.text !== "watch" || watching > 2 || !vueWatch(call)) return null;
  const list = args!.namedChildren.filter((a): a is Node => !!a && a.type !== "comment");
  const source = element === undefined ? (list[0]?.type === "array" ? null : list[0]) : list[0]?.type === "array" ? list[0].namedChildren.filter((c) => c?.type !== "comment")[element] : null;
  if (list[1]?.id !== fn.id || !source || source.type === "spread_element") return null;
  watching++;
  try {
    const found = originOf(unwrap(getterBody(source) ?? source).node, 1);
    return found && found.kind !== "literal" ? found : null;
  } finally {
    watching--;
  }
}

/** `defineProps(…)`, `withDefaults(defineProps(…), …)`: a Vue component's props object. */
function isDefineProps(n: Node): boolean {
  if (n.type !== "call_expression") return false;
  const fn = n.childForFieldName("function")?.text;
  if (fn === "defineProps") return true;
  const first = fn === "withDefaults" ? n.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment") : null;
  return !!first && isDefineProps(first);
}

/** What a component's props are destructured from: `defineProps()`, `toRefs(props)`, `props` itself. */
function propsSource(n: Node, depth: number): boolean {
  if (n.type === "call_expression" && n.childForFieldName("function")?.text === "toRefs") {
    const of = n.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment");
    return !!of && propsObject(of, depth + 1);
  }
  return propsObject(n, depth);
}

/**
 * Is `n` a component's props object: `defineProps(…)` or a local holding it,
 * the props parameter of a React function component, Vue's `setup(props)`,
 * or a class component's `this.props`?
 */
function propsObject(n: Node, depth: number): boolean {
  if (depth > 6) return false;
  if (n.type === "call_expression") return isDefineProps(n);
  if (n.type === "member_expression") return n.text === "this.props";
  if (n.type !== "identifier") return false;
  const site = paramSite(n, n.text);
  if (site) return site.index === 0 && site.plain && isComponentFunction(site.fn);
  const bound = bindingOf(n, n.text);
  return !!bound && bound.kind === "value" && propsObject(unwrap(bound.value).node, depth + 1);
}

/** The innermost function declaring `name` as a parameter, its position, and whether it is the whole parameter. */
function paramSite(at: Node, name: string): { fn: Node; index: number; plain: boolean } | null {
  for (let fn: Node | null = at.parent; fn; fn = fn.parent) {
    if (!FUNCTION_NODES.has(fn.type)) continue;
    const single = fn.childForFieldName("parameter");
    if (single?.type === "identifier") {
      if (single.text === name) return { fn, index: 0, plain: true };
      continue;
    }
    const params = fn.childForFieldName("parameters")?.namedChildren.filter((p) => p?.type !== "comment") ?? [];
    for (let i = 0; i < params.length; i++) {
      const pattern = params[i]!.childForFieldName("pattern") ?? params[i]!;
      const id = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
      if (id?.type === "identifier" && id.text === name) return { fn, index: i, plain: true };
      if (declares(pattern, name)) return { fn, index: i, plain: false };
    }
  }
  return null;
}

/**
 * A function whose first parameter is a component's props: a React function
 * component (a capitalized function, or one assigned to a capitalized name,
 * through `memo` / `forwardRef`), or a Vue `setup(props)`.
 */
function isComponentFunction(fn: Node): boolean {
  if (fn.type === "method_definition") return fn.childForFieldName("name")?.text === "setup";
  if (fn.type === "function_declaration") return /^[A-Z]/.test(fn.childForFieldName("name")?.text ?? "");
  let up = fn.parent;
  if (up?.type === "pair") return up.childForFieldName("key")?.text === "setup";
  // `memo((props) => …)`, `forwardRef(function (props, ref) { … })`
  if (up?.type === "arguments" && /^(?:React\.)?(?:memo|forwardRef|observer)$/.test(up.parent?.childForFieldName("function")?.text ?? "")) up = up.parent?.parent ?? null;
  return up?.type === "variable_declarator" && /^[A-Z]/.test(up.childForFieldName("name")?.text ?? "");
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

/** Where an expression's value comes from, one wrapper unwrapped: what a markup binding hands a child's prop. */
export function expressionOrigin(n: Node): { origin: Origin; transform?: string; derivation?: ValueStep[] } | null {
  const { node, transform } = unwrap(n);
  const found = originOf(node, 0);
  return found ? { ...split(found), ...(transform ? { transform } : {}) } : null;
}

/**
 * Where a template's value comes from — a member chain the markup spells
 * (`clubId`, `props.clubId`, `route.params.id`, `$route.query.q`) — read in
 * the scope of the component's script: `anchor` is a statement of the
 * script's program. A bare name the script does not bind is the component's
 * own prop when it declares one of that name (`declared`).
 */
export function templateValueOrigin(anchor: Node, chain: readonly string[], declared: ReadonlySet<string>): { origin: Origin; derivation?: ValueStep[] } | null {
  const found = templateValue(anchor, chain, declared);
  return found ? split(found) : null;
}

function templateValue(anchor: Node, chain: readonly string[], declared: ReadonlySet<string>): Found | null {
  const [head, ...rest] = chain;
  if (!head) return null;
  if (head === "props" && rest.length === 1) return { kind: "prop", name: rest[0]! };
  if ((head === "$route" || head === "$router") && rest.length === 2) {
    if (rest[0] === "params") return { kind: "route-param", name: rest[1]! };
    if (rest[0] === "query") return { kind: "query-param", name: rest[1]! };
    return null;
  }
  const bound = bindingOf(anchor, head);
  if (!bound) return rest.length === 0 && declared.has(head) ? { kind: "prop", name: head } : null;
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "value")) return identifierOrigin(anchor, head, 0);
  if (bound.kind !== "value") {
    // `club.id`, the template unwrapping a composable's member (`const { club } = useClub(…)`).
    let found = rest.length <= 2 ? identifierOrigin(anchor, head, 0) : null;
    for (const p of rest) found = readOffLookup(found, p);
    return found;
  }
  const value = unwrap(bound.value).node;
  if (rest.length === 1 && propsObject(value, 1)) return { kind: "prop", name: rest[0]! };
  // `club.id`, the template unwrapping `club = computed(() => clubStore.clubs[props.clubId])`.
  if (rest.length === 1) return readOffLookup(identifierOrigin(anchor, head, 0), rest[0]!);
  if (rest.length === 2 && rest[0] === "params" && routeObject(value, 1)) return { kind: "route-param", name: rest[1]! };
  if (rest.length === 2 && rest[0] === "query" && (routeObject(value, 1) || routerObject(value))) return { kind: "query-param", name: rest[1]! };
  return null;
}

/**
 * The locals a composable hands back whose value derives from one of its
 * parameters (`FunctionInfo.derivedLocals`), read in `fn`'s own body: a
 * `computed` whose getter is a lookup keyed by the parameter or a function's
 * result for it (`computed(() => clubStore.clubs[toValue(clubId)])`), or a
 * `ref` every assignment of which is such a value (`club.value = await
 * getClub(id)` in `watch(() => toValue(clubId), async (id) => …)`). A local
 * with any other assignment, or one derived from no parameter, is left out.
 */
export function derivedLocalsOf(fn: Node, locals: readonly string[]): Array<{ local: string; param: number; derivation?: ValueStep[] }> | undefined {
  const body = fn.childForFieldName("body");
  if (body?.type !== "statement_block" || locals.length === 0) return undefined;
  const single = fn.childForFieldName("parameter");
  const params = single ? [single] : fn.childForFieldName("parameters")?.namedChildren.filter((p): p is Node => !!p && p.type !== "comment") ?? [];
  const names = params.map((p) => {
    const pattern = p.childForFieldName("pattern") ?? p;
    const id = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
    return id?.type === "identifier" ? id.text : "";
  });
  if (!names.some(Boolean)) return undefined;
  const out: Array<{ local: string; param: number; derivation?: ValueStep[] }> = [];
  readingLocals++;
  try {
    for (const local of locals) {
      const init = declaredValue(body, local);
      const held = init ? unwrap(init).node : null;
      const callee = init?.type === "call_expression" ? init.childForFieldName("function")?.text : undefined;
      const values: Node[] = [];
      if (callee === "computed" && held && held.id !== init!.id) values.push(held);
      else if (callee === "ref" || callee === "shallowRef") {
        const first = init!.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment");
        if (first && !emptyValue(first)) values.push(first);
        if (!assignedValues(body, local, values)) continue;
      } else continue;
      let agreed: { param: number; derivation?: ValueStep[] } | null = null;
      let refused = values.length === 0;
      for (const value of values) {
        const found = originOf(unwrap(stripAwait(value)).node, 0);
        // The composable's own parameter, by its place: not a callback's of the same name.
        if (found?.kind !== "param" || names[found.index] !== found.name) {
          refused = true;
          break;
        }
        const here = { param: found.index, ...(found.steps?.length ? { derivation: found.steps } : {}) };
        if (agreed && JSON.stringify(agreed) !== JSON.stringify(here)) {
          refused = true;
          break;
        }
        agreed = here;
      }
      if (!refused && agreed) out.push({ local, ...agreed });
    }
  } finally {
    readingLocals--;
  }
  return out.length ? out : undefined;
}

/** The initializer of `const name = …` among the body's own statements. */
function declaredValue(body: Node, name: string): Node | null {
  for (const stmt of body.namedChildren) {
    if (stmt?.type !== "lexical_declaration" && stmt?.type !== "variable_declaration") continue;
    for (const d of stmt.namedChildren) {
      if (d?.type === "variable_declarator" && d.childForFieldName("name")?.text === name) return d.childForFieldName("value");
    }
  }
  return null;
}

/** `null`, `undefined`, `[]`, `{}`, a literal: what a ref starts as or is reset to, not a value it is derived to. */
function emptyValue(n: Node): boolean {
  const v = unwrap(n).node;
  if (v.type === "null" || v.type === "undefined" || v.type === "string" || v.type === "number" || v.type === "true" || v.type === "false") return true;
  if (v.type === "identifier") return v.text === "undefined";
  return (v.type === "array" || v.type === "object") && v.namedChildren.every((c) => c?.type === "comment");
}

/**
 * Every value assigned to `local.value` in the body, nested callbacks and
 * functions included (empty resets left out), into `into`; false when the
 * local is assigned otherwise (`local = …`, `local.value += …`).
 */
function assignedValues(body: Node, local: string, into: Node[]): boolean {
  let ok = true;
  const visit = (n: Node): void => {
    if (!ok) return;
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") {
      const left = n.childForFieldName("left");
      const target = left?.type === "member_expression" && left.childForFieldName("property")?.text === "value" ? left.childForFieldName("object") : left;
      if (target?.type === "identifier" && target.text === local) {
        const right = n.childForFieldName("right");
        if (n.type !== "assignment_expression" || left === target || !right) ok = false;
        else if (!emptyValue(right)) into.push(right);
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(body);
  return ok;
}

function stripAwait(n: Node): Node {
  let v = n;
  while (v.type === "await_expression" || v.type === "parenthesized_expression") v = v.namedChild(0) ?? v;
  return v;
}
