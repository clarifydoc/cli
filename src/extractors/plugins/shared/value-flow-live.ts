import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";

const keyOf = (c: ValueCell): string => `${c.name}\0${c.member ?? ""}`;
const RECEIVERS = new Set(["this", "self"]);

/**
 * Keep only the facts that can matter to a link. A plugin states every statement shape it reads (each `x = f()`,
 * each `run(x)`); most name a cell nothing ever runs or hands on, and would only grow the per-file output. A
 * fact stays when
 *  - it fills a cell (seed, copy, result) that something reads — an invoke, an argument, a return, a field store
 *    on the receiver, or a copy into such a cell;
 *  - it reads a cell (arg, invoke, return) that a kept fact fills, a parameter holds, or the receiver's field
 *    stands for (stored by another method).
 * `params` are the function's formals, which callers fill. With `bindBases` (a language whose every variable is a
 * local of the function), a kept fact on a member or element of a plain variable (`m['a']`, `o.h`) is preceded by a
 * self-copy of that variable, which binds it as the function's own — a store to `m.a` alone binds nothing.
 */
export function liveValueFlow(facts: readonly ValueFlowFact[], params: readonly string[], options: { bindBases?: boolean; localName?: (name: string) => boolean; external?: (name: string) => boolean } = {}): ValueFlowFact[] {
  if (facts.length === 0) return [];
  const read = new Set<string>();
  for (const f of facts) {
    if (f.kind === "invoke") read.add(keyOf(f.cell));
    else if (f.kind === "arg" || f.kind === "return") read.add(keyOf(f.from));
    else if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member !== undefined && RECEIVERS.has(f.to.name)) read.add(keyOf(f.to));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of facts) {
      if (f.kind !== "copy" || !read.has(keyOf(f.to)) || read.has(keyOf(f.from))) continue;
      read.add(keyOf(f.from));
      changed = true;
    }
  }
  const kept = new Set<ValueFlowFact>();
  const filled = new Set<string>();
  for (const f of facts) {
    if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && read.has(keyOf(f.to))) {
      kept.add(f);
      filled.add(keyOf(f.to));
    }
  }
  const sourced = (c: ValueCell, field: boolean): boolean =>
    filled.has(keyOf(c)) || options.external?.(c.name) === true || (c.member === undefined && params.includes(c.name)) || (field && c.member !== undefined && RECEIVERS.has(c.name));
  // A field read means something only where it is run (an invoke): handing a field on or returning it states
  // nothing a function value could ride on that the field's own stores do not already reach.
  for (const f of facts) {
    if (f.kind === "arg" || f.kind === "return") { if (sourced(f.from, false)) kept.add(f); }
    else if (f.kind === "invoke") { if (sourced(f.cell, true)) kept.add(f); }
  }
  // A function with no function value of its own (a seed), no run of one and no parameter handed on states nothing.
  const kind = (k: string): boolean => facts.some((f) => kept.has(f) && f.kind === k);
  const paramFlow = facts.some((f) => kept.has(f) && (f.kind === "arg" || f.kind === "return" || f.kind === "copy") && "from" in f && f.from.member === undefined && params.includes(f.from.name));
  if (!kind("seed") && !kind("invoke") && !paramFlow) return [];
  // Keep the statement order the extractor read them in.
  const out = facts.filter((f) => kept.has(f));
  if (!options.bindBases) return out;
  const bound = new Set<string>(params);
  for (const f of out) if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member === undefined) bound.add(f.to.name);
  const binders: ValueFlowFact[] = [];
  const bind = (c: ValueCell, line: number): void => {
    if (c.member === undefined || RECEIVERS.has(c.name) || bound.has(c.name) || c.name.startsWith("%") || options.localName?.(c.name) === false) return;
    bound.add(c.name);
    binders.push({ kind: "copy", from: { name: c.name }, to: { name: c.name }, line });
  };
  for (const f of out) {
    if (f.kind === "seed" || f.kind === "result") bind(f.to, f.line);
    else if (f.kind === "copy") { bind(f.to, f.line); bind(f.from, f.line); }
    else if (f.kind === "arg" || f.kind === "return") bind(f.from, f.line);
    else bind(f.cell, f.line);
  }
  return [...binders, ...out];
}
