import type { Node } from "web-tree-sitter";

/** Function expressions — anonymous ones run on the enclosing function's behalf. */
export const FUNCTION_EXPRESSIONS: ReadonlySet<string> = new Set(["arrow_function", "function_expression"]);

/**
 * Wrappers that return (a memoized, debounced, observing or ref-forwarding
 * version of) the function they are given: `useCallback(fn, deps)`,
 * `memo(Component)`, `forwardRef(render)`, mobx-react's `observer(Component)`,
 * lodash `debounce(fn, ms)` / `throttle(fn, ms)`, VueUse `useDebounceFn(fn, ms)` / `useThrottleFn(fn, ms)`. A member callee counts by
 * its leaf (`React.memo`, `React.forwardRef`).
 */
const IDENTITY_WRAPPERS: ReadonlySet<string> = new Set([
  "useCallback", "useEvent", "useEffectEvent", "useMemoizedFn", "memo", "forwardRef", "observer", "debounce", "throttle", "useDebounceFn", "useThrottleFn",
]);

/** The wrappers of a function that run it unchanged, later or limited (not the ones of components). */
const CALLBACK_WRAPPERS: ReadonlySet<string> = new Set(["useCallback", "useEvent", "useEffectEvent", "useMemoizedFn", "debounce", "throttle", "useDebounceFn", "useThrottleFn"]);

/**
 * The function a wrapper is given BY NAME (`const onSearch = useDebounceFn(applySearch, 300)`,
 * `useCallback(saveClub, [])`): the binding runs it, so it is a function whose one call is that name.
 */
export function wrappedCalleeName(value: Node): string | null {
  if (value.type !== "call_expression") return null;
  const name = wrapperName(value);
  if (!name || !CALLBACK_WRAPPERS.has(name)) return null;
  const first = value.childForFieldName("arguments")?.namedChildren[0];
  return first && (first.type === "identifier" || (first.type === "member_expression" && /^[\w$]+(?:\.[\w$]+)+$/.test(first.text))) ? first.text : null;
}

/**
 * Wrappers whose binding runs the function they are given LAST: Redux
 * Toolkit's `createAsyncThunk("posts/fetch", async () => …)` — dispatching
 * the thunk runs its payload creator, so the binding names that body.
 */
const BODY_LAST_WRAPPERS: ReadonlySet<string> = new Set(["createAsyncThunk"]);

/** Expressions that only parenthesize or type what they hold. */
const TYPE_WRAPPERS = new Set(["parenthesized_expression", "satisfies_expression", "as_expression", "type_assertion", "non_null_expression"]);

/** The wrapper a call is — its callee's name, or a member callee's leaf (`React.memo` → `memo`). */
function wrapperName(call: Node): string | undefined {
  const callee = call.childForFieldName("function");
  return callee?.type === "identifier" ? callee.text : callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
}

/**
 * The function an identity wrapper call is given as its first argument (or a
 * body-last wrapper its last), if any — through nested identity wrappers
 * (`memo(forwardRef((props, ref) => …))`) — or a function only parenthesized
 * or typed (`(async () => …) satisfies PageLoad`).
 */
export function wrappedFunction(value: Node, depth = 0): Node | null {
  // `(async ({ url }) => { … }) satisfies PageLoad`, `(() => …) as Handler`: a typed function.
  let inner: Node | null = value;
  while (inner && TYPE_WRAPPERS.has(inner.type)) inner = inner.namedChildren[0] ?? null;
  if (inner !== value && inner && FUNCTION_EXPRESSIONS.has(inner.type)) return inner;
  if (value.type !== "call_expression") return null;
  const name = wrapperName(value);
  if (!name) return null;
  const args = value.childForFieldName("arguments")?.namedChildren ?? [];
  if (BODY_LAST_WRAPPERS.has(name)) {
    const fn = [...args].reverse().find((a) => FUNCTION_EXPRESSIONS.has(a.type));
    return fn ?? null;
  }
  if (!IDENTITY_WRAPPERS.has(name)) return null;
  const first = args[0];
  if (first && FUNCTION_EXPRESSIONS.has(first.type)) return first;
  return first?.type === "call_expression" && depth < 3 ? wrappedFunction(first, depth + 1) : null;
}

/**
 * The name a module's default export gives what an identity wrapper wraps:
 * `export default memo(function FancyBadge() {…})` → `FancyBadge`,
 * `export default observer(Garage)` → `Garage`. Null for anything else — an
 * anonymous function has no name to give.
 */
export function wrappedDefaultName(value: Node, depth = 0): string | null {
  if (value.type !== "call_expression") return null;
  const name = wrapperName(value);
  if (!name || !IDENTITY_WRAPPERS.has(name)) return null;
  const first = value.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type === "identifier") return first.text;
  if (first?.type === "function_expression") return first.childForFieldName("name")?.text ?? null;
  return first?.type === "call_expression" && depth < 3 ? wrappedDefaultName(first, depth + 1) : null;
}

/**
 * Whether a function expression is the one a module-level binding names
 * through a wrapper — `const Tyre = observer(() => …)`, `export default
 * memo(function FancyBadge() {…})`: that binding is a function of its own, so
 * its calls are not the module's top level.
 */
export function boundThroughWrapper(fn: Node): boolean {
  let call: Node | null = fn.parent?.type === "arguments" ? fn.parent.parent : null;
  // Out through nested wrappers to the outermost call.
  while (call?.type === "call_expression" && call.parent?.type === "arguments" && call.parent.parent?.type === "call_expression") call = call.parent.parent;
  if (call?.type !== "call_expression" || wrappedFunction(call)?.id !== fn.id) return false;
  const holder = call.parent;
  if (holder?.type === "variable_declarator") return holder.childForFieldName("name")?.type === "identifier";
  return holder?.type === "export_statement" && fn.type === "function_expression" && !!fn.childForFieldName("name");
}

/**
 * The function a module-level binding made by handing it to a wrapper of the project or a library
 * runs — `export const main = handler(async (event) => {…})`, `export const getClub =
 * asyncHandler(async (req, res) => {…})`, `export const GET = withAuth(async (req) => {…})`: what the
 * binding runs is that function, so it names it. Only a handler-shaped argument — async, or (exported)
 * a block body; a factory returning an object (`create((set) => ({…}))`) is no handler. A binding no
 * one imports (`const getClubs = withAuth(async …)`, registered later) holds to `async`.
 */
export function handlerOf(value: Node, exported: boolean): Node | null {
  if (value.type !== "call_expression" || value.childForFieldName("function")?.type !== "identifier") return null;
  const first = value.childForFieldName("arguments")?.namedChildren[0];
  if (!first || !FUNCTION_EXPRESSIONS.has(first.type)) return null;
  const async = first.text.startsWith("async");
  return async || (exported && first.childForFieldName("body")?.type === "statement_block") ? first : null;
}

/**
 * Whether a function expression is the handler a module-level binding names through a wrapper
 * (`handlerOf`): that binding is a function of its own, so its calls are not the module's top level.
 */
export function boundHandler(fn: Node): boolean {
  const call = fn.parent?.type === "arguments" ? fn.parent.parent : null;
  // `export default withAuth(async (req, res) => …)`: the module's default function.
  if (call?.type === "call_expression" && call.parent?.type === "export_statement" && call.parent.parent?.type === "program") return !wrappedFunction(call) && handlerOf(call, true)?.id === fn.id;
  const declarator = call?.parent;
  if (call?.type !== "call_expression" || declarator?.type !== "variable_declarator" || declarator.childForFieldName("name")?.type !== "identifier") return false;
  const declaration = declarator.parent;
  const holder = declaration?.parent;
  if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") return false;
  const exported = holder?.type === "export_statement" && holder.parent?.type === "program";
  if (!exported && holder?.type !== "program") return false;
  return handlerOf(call, exported)?.id === fn.id;
}
