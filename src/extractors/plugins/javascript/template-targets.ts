/**
 * What a Vue template statement writes (`@click="page = 2"`, `filters.league = x`, `showAll = !showAll`, `count++`,
 * `picked.push(c)`, a `v-model`'s target), by the name it starts from. The markup reader states each as a short
 * token in the parsed text (`encodeTargets`) so no handler code — a call, a URL — is left there for a text scan to read,
 * and the reactive-cell reader turns the tokens back (`decodeTargets`) into the cells they land in.
 */

/** A name a template statement changes, with the members below it (`null`: a computed member). */
export interface TemplateTarget { root: string; steps: Array<string | null>; mutated: boolean; falsy: boolean }

const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);
/** A switch-off value: what a write of it never turns on. */
const FALSY = /^(?:false|null|undefined|''|""|``|0)$/;
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g;
const TARGET = /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*)/g;
const ASSIGN = /^\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])/;
/** An increment or decrement written before a name: it follows the start of a statement or an operator that takes an operand, never a subtraction. */
const PREFIX_STEP = /(?:^|[;,({=:?!&|])\s*(?:\+\+|--)\s*$/;

/**
 * The names `expr` writes. Names the template binds below the element (`bound`) are not the component's, nor is an
 * arrow function's own parameter inside that arrow's body.
 */
export function templateTargets(expr: string, bound: ReadonlySet<string> = new Set()): TemplateTarget[] {
  const norm = expr.replace(/\?\./g, ".");
  const blank = norm.replace(STRING_LITERAL, (m) => " ".repeat(m.length));
  // An arrow's parameters shadow from its `=>` on.
  const shadows: Array<{ from: number; names: Set<string> }> = [];
  for (const m of blank.matchAll(/\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>/g)) {
    shadows.push({ from: m.index! + m[0].length, names: new Set((m[1] ?? m[2] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) });
  }
  const out: TemplateTarget[] = [];
  const stepsOf = (path: string) => [...path.matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[[^\]]*\]/g)].map((s) => s[1] ?? null);
  for (const m of blank.matchAll(TARGET)) {
    const root = m[1]!;
    if (bound.has(root) || shadows.some((s) => s.from <= m.index! && s.names.has(root))) continue;
    const steps = stepsOf(m[2] ?? "");
    const end = m.index! + m[0].length;
    const after = blank.slice(end);
    const assign = ASSIGN.exec(after);
    if (assign) {
      const right = norm.slice(end + assign[0].length).split(";")[0]!.trim();
      out.push({ root, steps, mutated: false, falsy: FALSY.test(right) });
    } else if (/^\s*(?:\+\+|--)/.test(after) || PREFIX_STEP.test(blank.slice(0, m.index!))) {
      out.push({ root, steps, mutated: false, falsy: false });
    } else if (steps.length > 0 && MUTATORS.has(steps[steps.length - 1] ?? "") && /^\s*\(/.test(after)) {
      out.push({ root, steps: steps.slice(0, -1), mutated: true, falsy: false });
    }
  }
  return out;
}

/** `f:open`, `m:picked`, `-:filters.league`: flags (`m` a mutator call, `f` a switch-off value, `-` none), a colon, the path (`[]` a computed member). */
export function encodeTargets(targets: readonly TemplateTarget[]): string {
  return targets.map((t) => `${t.mutated ? "m" : t.falsy ? "f" : "-"}:${[t.root, ...t.steps.map((s) => s ?? "[]")].join(".")}`).join(" ");
}

export function decodeTargets(text: string): TemplateTarget[] {
  const out: TemplateTarget[] = [];
  for (const token of text.split(/\s+/)) {
    const m = /^([mf-]):([A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\[\]))*)$/.exec(token);
    if (!m) continue;
    const [root, ...rest] = m[2]!.split(".");
    out.push({ root: root!, steps: rest.map((s) => (s === "[]" ? null : s)), mutated: m[1] === "m", falsy: m[1] === "f" });
  }
  return out;
}
