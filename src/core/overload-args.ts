/**
 * Choosing between overloads of one arity by what the call's arguments are
 * (`CallInfo.argKinds`) and what each overload's parameters are declared as.
 * Language-agnostic: the plugin writes the argument kinds and folds declared
 * types to the same keys (`calls.overloadTypeKey`); this module only compares
 * keys — exact over assignable over unknown, never a guess where nothing is
 * known.
 */

/** Primitive keys, each with the keys it widens to (`int` passes where a `long` is declared). */
const WIDENS_TO: Readonly<Record<string, readonly string[]>> = {
  byte: ["short", "int", "long", "float", "double"],
  short: ["int", "long", "float", "double"],
  char: ["int", "long", "float", "double"],
  int: ["long", "float", "double"],
  long: ["float", "double"],
  float: ["double"],
  double: [],
  boolean: [],
};

/** A key no class can stand for: a primitive or the string type. */
function isValueKey(key: string): boolean {
  return key in WIDENS_TO || key === "string";
}

/** `->N:void` / `->N:value` / `->N` / `->` as arity (null = open) and result (null = either). */
function lambdaShape(key: string): { arity: number | null; result: "void" | "value" | null } | null {
  const m = /^->(\d+)?(?::(void|value))?$/.exec(key);
  if (!m) return null;
  return { arity: m[1] != null ? Number(m[1]) : null, result: (m[2] as "void" | "value" | undefined) ?? null };
}

/** What the scorer knows of the project's classes: the supertypes of a type by simple name. */
export interface TypeHierarchy {
  /** The type's supertypes (transitively), and whether every one of them is a project type (`closed`); null for a type the project does not declare. */
  ancestors(type: string): { names: ReadonlySet<string>; closed: boolean } | null;
}

/**
 * How well one argument fits one parameter: 3 exact, 2 assignable (widening,
 * a subtype, a lambda of the right shape), 1 unknown (either side unknown, or
 * the parameter is the top type), 0 impossible.
 */
export function argFit(arg: string, param: string | null, types: TypeHierarchy): number {
  if (!param || param === "?" || arg === "?" || arg.startsWith("@")) return 1;
  const pLambda = lambdaShape(param);
  const aLambda = lambdaShape(arg);
  if (aLambda) {
    if (!pLambda) return isValueKey(param) ? 0 : 1;
    if (aLambda.arity != null && pLambda.arity != null && aLambda.arity !== pLambda.arity) return 0;
    if (aLambda.result && pLambda.result && aLambda.result !== pLambda.result) return 0;
    return aLambda.arity != null && aLambda.result && pLambda.result ? 3 : 2;
  }
  if (arg === param) return 3;
  if (param === "object") return 1;
  if (arg === "null") return isValueKey(param) && param !== "string" ? 0 : 1;
  if (isValueKey(arg)) {
    if (WIDENS_TO[arg]?.includes(param)) return 2;
    if (isValueKey(param) || pLambda) return 0;
    // A value never is a project class; an external type may be one of its supertypes (`CharSequence`, `Number`).
    return types.ancestors(param) ? 0 : 1;
  }
  // The argument is a class type.
  if (isValueKey(param)) return 0;
  if (pLambda) return 1;
  const up = types.ancestors(arg);
  if (up) return up.names.has(param) ? 2 : up.closed ? 0 : 1;
  // A type the project does not declare cannot extend one it does.
  return types.ancestors(param) ? 0 : 1;
}

/** One overload's parameters, folded to keys (receivers left out), and whether the last takes any number. */
export interface OverloadParams {
  types: readonly (string | null)[];
  variadic: boolean;
}

/**
 * The overload the arguments fit best, by index into `candidates` (all of
 * which accept the call's arity), or -1 when the kinds cannot tell: every
 * argument unknown, no overload possible, or a tie at the top.
 */
export function bestOverload(argKinds: readonly string[], candidates: readonly OverloadParams[], types: TypeHierarchy): number {
  if (!argKinds.some((k) => k !== "?" && !k.startsWith("@"))) return -1;
  let best = -1;
  let bestScore = -1;
  let tie = false;
  candidates.forEach((o, i) => {
    let score = 0;
    for (let a = 0; a < argKinds.length; a++) {
      // Arguments past a variadic parameter's position are not compared.
      const fit = o.variadic && a >= o.types.length - 1 ? 1 : argFit(argKinds[a]!, o.types[a] ?? null, types);
      if (fit === 0) return;
      score += fit;
    }
    if (score > bestScore) {
      best = i;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) tie = true;
  });
  return tie ? -1 : best;
}
