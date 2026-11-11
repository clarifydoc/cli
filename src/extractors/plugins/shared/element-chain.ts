/**
 * What an expression's text says about the element it yields — the one reading the brace languages (Java, Kotlin,
 * C#) share for `for (var k : cars)`, `cars.forEach { it.wash() }`, `cars.get(0).wash()` and
 * `squad.Where(c => c.Fast).First().Wash()`. A plugin states what each of its collection, map and optional types
 * and methods mean (`ChainRules`); this walks a chain written as text, one step at a time, from a root name whose
 * declared type the plugin already knows. A step it does not know ends the walk: nothing is guessed.
 */

/** What an expression is, as far as the source states it. */
export type ElementState =
  | { kind: "coll"; elem: string }
  | { kind: "map"; elem: string; /** The key type as written, when the plugin reads it (`Map<Club, Player>` → `Club`). */ key?: string }
  | { kind: "optional"; elem: string }
  | { kind: "value"; type: string };

export interface ChainRules {
  /** A declared type as written → collection / map / optional (element text as written), else null. */
  parseType(text: string): { kind: "coll" | "map" | "optional"; elem: string; key?: string } | null;
  /** A type text that names a class a member call can land on (`Car`, `a.b.Car<T>` → written back), else null. */
  classOf(text: string): string | null;
  /** Collection → one element (`get`, `first`, `FirstOrDefault`). */
  elementOf: ReadonlySet<string>;
  /** Map → one value (`get`, `getValue`). */
  mapValueOf: ReadonlySet<string>;
  /** Collection → collection of the same elements (`filter`, `Where`, `stream`). */
  keeps: ReadonlySet<string>;
  /** Collection → optional element (`findFirst`). */
  toOptional: ReadonlySet<string>;
  /** Optional → its element (`get`, `orElseThrow`). */
  optionalValue: ReadonlySet<string>;
  /** Map → its values as a collection (`values`, `Values`). */
  values: ReadonlySet<string>;
  /** Map → its keys as a collection (`keys`, `keySet`); needs the plugin to state the key type. */
  keys?: ReadonlySet<string>;
  /** Collection → collection of the type argument (`filterIsInstance<Car>()`, `OfType<Car>()`). */
  filterByType: ReadonlySet<string>;
  /** `x[i]` is the element (Kotlin, C#, a Java array's `[]` is the same). */
  indexer: boolean;
  /** Collection methods handing the element to a callback → the callback's parameter positions that are the element. */
  callbacks: ReadonlyMap<string, readonly number[]>;
  /** Map methods handing the value to a callback → the parameter positions. */
  mapCallbacks: ReadonlyMap<string, readonly number[]>;
  /** Optional methods handing the element to a callback. */
  optionalCallbacks: ReadonlySet<string>;
  /** Value methods handing the value itself to a callback (`let`, `also`) → the parameter position. */
  valueCallbacks: ReadonlySet<string>;
}

interface Step {
  name: string;
  call: boolean;
  /** `<Car>` after the name, as written. */
  typeArg?: string;
  /** `[…]` rather than `.name`. */
  index?: boolean;
}

/** The index just past the bracket pair opening at `from`, strings respected; -1 when it never closes. */
function closeOf(text: string, from: number): number {
  const open = text[from]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : ">";
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** `cars.get(0).wash` style text → its root name and steps, null when it is not a plain chain. */
export function parseChain(text: string): { root: string; steps: Step[] } | null {
  let t = text.trim().replace(/^this(?:@\w+)?\s*\.\s*/, "");
  const head = /^[A-Za-z_]\w*/.exec(t);
  if (!head) return null;
  const root = head[0];
  t = t.slice(root.length);
  const steps: Step[] = [];
  for (let guard = 0; guard < 32; guard++) {
    t = t.replace(/^\s+/, "").replace(/^!!?(?![=])/, "");
    if (t === "") return { root, steps };
    if (t[0] === "?" && t[1] !== "." && t[1] !== "[") {
      t = t.slice(1);
      continue;
    }
    if (t[0] === "?") t = t.slice(1);
    if (t[0] === "[") {
      const end = closeOf(t, 0);
      if (end < 0) return null;
      steps.push({ name: "", call: false, index: true });
      t = t.slice(end);
      continue;
    }
    if (t[0] !== ".") return null;
    t = t.slice(1).replace(/^\s+/, "");
    const name = /^[A-Za-z_]\w*/.exec(t);
    if (!name) return null;
    t = t.slice(name[0].length);
    const step: Step = { name: name[0], call: false };
    const probe = t.replace(/^\s+/, "");
    if (probe[0] === "<") {
      const end = closeOf(probe, 0);
      if (end < 0) return null;
      step.typeArg = probe.slice(1, end - 1).trim();
      t = probe.slice(end);
    }
    let next = t.replace(/^\s+/, "");
    if (next[0] === "(") {
      const end = closeOf(next, 0);
      if (end < 0) return null;
      step.call = true;
      t = next.slice(end);
      next = t.replace(/^\s+/, "");
    }
    // A trailing lambda (`cars.filter { it.fast() }`) is the call's last argument.
    if (next[0] === "{") {
      const end = closeOf(next, 0);
      if (end < 0) return null;
      step.call = true;
      t = next.slice(end);
    }
    steps.push(step);
  }
  return null;
}

/** What a type text is: a collection, map, optional, or a class value; null for anything else. */
export function stateOfType(text: string | null | undefined, rules: ChainRules): ElementState | null {
  if (!text) return null;
  const parsed = rules.parseType(text);
  if (parsed) return parsed;
  const cls = rules.classOf(text);
  return cls ? { kind: "value", type: cls } : null;
}

/** One step of a chain from `state`, null when the rules do not say what it yields. */
function apply(state: ElementState, step: Step, rules: ChainRules): ElementState | null {
  if (step.index) {
    if (!rules.indexer) return null;
    return state.kind === "coll" || state.kind === "map" ? stateOfType(state.elem, rules) : null;
  }
  const { name } = step;
  switch (state.kind) {
    case "coll":
      if (!step.call) return null;
      if (rules.keeps.has(name)) return state;
      if (rules.elementOf.has(name)) return stateOfType(state.elem, rules);
      if (rules.toOptional.has(name)) return { kind: "optional", elem: state.elem };
      if (rules.filterByType.has(name) && step.typeArg) return { kind: "coll", elem: step.typeArg };
      return null;
    case "map":
      if (rules.values.has(name)) return { kind: "coll", elem: state.elem };
      if (rules.keys?.has(name) && state.key) return { kind: "coll", elem: state.key };
      if (!step.call) return null;
      if (rules.mapValueOf.has(name)) return stateOfType(state.elem, rules);
      return null;
    case "optional":
      return step.call && rules.optionalValue.has(name) ? stateOfType(state.elem, rules) : null;
    default:
      return null;
  }
}

/** The state of the chain `text`, its root name's state given by `rootState`. */
export function chainState(text: string, rootState: (name: string) => ElementState | undefined, rules: ChainRules): ElementState | null {
  const chain = parseChain(text);
  if (!chain) return null;
  let state: ElementState | null = rootState(chain.root) ?? null;
  for (const step of chain.steps) {
    if (!state) return null;
    state = apply(state, step, rules);
  }
  return state;
}

/**
 * What a callback handed to `<receiver>.<method>(…)` receives: the class its element parameters are, and which
 * parameter positions they are. Null when the receiver is not a typed collection, map or optional, or the method
 * hands its callback something else.
 */
export function callbackElement(
  receiver: string,
  method: string,
  rootState: (name: string) => ElementState | undefined,
  rules: ChainRules,
): { type: string; positions: readonly number[] } | null {
  const state = chainState(receiver, rootState, rules);
  if (!state) return null;
  let positions: readonly number[] | undefined;
  let elem: string | undefined;
  if (state.kind === "coll") {
    positions = rules.callbacks.get(method);
    elem = state.elem;
  } else if (state.kind === "map") {
    positions = rules.mapCallbacks.get(method);
    elem = state.elem;
  } else if (state.kind === "optional") {
    if (rules.optionalCallbacks.has(method)) positions = [0];
    elem = state.elem;
  } else if (rules.valueCallbacks.has(method)) {
    return { type: state.type, positions: [0] };
  }
  const type = elem ? rules.classOf(elem) : null;
  return positions && type && !rules.parseType(elem!) ? { type, positions } : null;
}

/** The class a loop variable over `iterable` takes (a collection's element; a map is never looped here). */
export function loopElement(
  iterable: string,
  rootState: (name: string) => ElementState | undefined,
  rules: ChainRules,
): string | null {
  const state = chainState(iterable, rootState, rules);
  return state?.kind === "coll" ? rules.classOf(state.elem) : null;
}

/** The class a chain expression evaluates to, when it ends in one element value. */
export function valueOfChain(
  text: string,
  rootState: (name: string) => ElementState | undefined,
  rules: ChainRules,
): string | null {
  const state = chainState(text, rootState, rules);
  return state?.kind === "value" ? state.type : null;
}

/** Split a type-argument list at its depth-0 commas (`String, Map<A, B>` → two). */
export function splitTypeArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((a) => a !== "");
}

/**
 * A generic type text as `{ name, args }`: `java.util.List<? extends Car>` → `List`, [`Car`]. Variance words and
 * a trailing `?` are dropped; null when the text is not one name with arguments.
 */
export function genericParts(text: string): { name: string; args: string[] } | null {
  const t = text
    .trim()
    .replace(/\?$/, "")
    .replace(/^(?:final|out|in)\s+/, "");
  const lt = t.indexOf("<");
  if (lt < 0) {
    const arr = /^(.+)\[\]$/.exec(t);
    return arr ? { name: "[]", args: [arr[1]!.trim()] } : /^[A-Za-z_][\w.]*$/.test(t) ? { name: t.slice(t.lastIndexOf(".") + 1), args: [] } : null;
  }
  if (!t.endsWith(">")) return null;
  const base = t.slice(0, lt).trim();
  if (!/^[A-Za-z_][\w.]*$/.test(base)) return null;
  const args = splitTypeArgs(t.slice(lt + 1, -1)).map((a) =>
    a.replace(/^\?\s*(?:extends|super)\s+/, "").replace(/^(?:out|in)\s+/, "").trim(),
  );
  if (args.some((a) => a === "?" || a === "*")) return null;
  return { name: base.slice(base.lastIndexOf(".") + 1), args };
}

/** `cars.get(0).wash` → receiver `cars.get(0)` and method `wash`, split at the last depth-0 dot. */
export function splitCallName(name: string): { receiver: string; method: string } | null {
  let depth = 0;
  for (let i = name.length - 1; i > 0; i--) {
    const ch = name[i]!;
    if (ch === ")" || ch === "]" || ch === ">") depth++;
    else if (ch === "(" || ch === "[" || ch === "<") depth--;
    else if (ch === "." && depth === 0) {
      const method = name.slice(i + 1);
      return /^[A-Za-z_]\w*$/.test(method) ? { receiver: name.slice(0, i), method } : null;
    }
  }
  return null;
}

/**
 * `squad[3].Sign` → `squad.Item().Sign`: an index step spelled as the call of the indexer the language names it by,
 * which the linker types through that member's declared return type. Null when the text has no index step or is not
 * a plain chain.
 */
export function indexerAsCall(text: string, indexerName: string): string | null {
  if (!text.includes("[")) return null;
  const chain = parseChain(text);
  if (!chain || !chain.steps.some((s) => s.index)) return null;
  let out = text.trim().replace(/^this(?:@\w+)?\s*\.\s*/, "");
  let result = "";
  let i = 0;
  while (i < out.length) {
    const ch = out[i]!;
    if (ch === "[" || (ch === "?" && out[i + 1] === "[")) {
      const start = ch === "?" ? i + 1 : i;
      const end = closeOf(out, start);
      if (end < 0) return null;
      result += `.${indexerName}()`;
      i = end;
      continue;
    }
    result += ch;
    i++;
  }
  out = result;
  return out;
}
