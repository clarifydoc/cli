import type { Node } from "web-tree-sitter";

/** Function expressions — anonymous ones run on the enclosing function's behalf. */
export const FUNCTION_EXPRESSIONS: ReadonlySet<string> = new Set(["arrow_function", "function_expression"]);

/**
 * Wrappers that return (a memoized, debounced, observing or ref-forwarding
 * version of) the function they are given: `useCallback(fn, deps)`,
 * `memo(Component)`, `forwardRef(render)`, mobx-react's `observer(Component)`,
 * lodash `debounce(fn, ms)` / `throttle(fn, ms)`. A member callee counts by
 * its leaf (`React.memo`, `React.forwardRef`).
 */
const IDENTITY_WRAPPERS: ReadonlySet<string> = new Set([
  "useCallback", "useEvent", "useEffectEvent", "useMemoizedFn", "memo", "forwardRef", "observer", "debounce", "throttle",
]);

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
