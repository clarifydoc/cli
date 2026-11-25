import type { Node } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";

/** Most facts one function states: a generated initializer would otherwise swell the file for no reader. */
export const MAX_FACTS = 40;

export type Effects = Pick<FunctionInfo, "fieldWrites" | "throws">;

/** A written member and the receiver text it is written on (`""` bare, `this`, `this.field`, a typed name). */
export interface WriteTarget { receiver: string; member: string }

/** The names whose type a function states: its typed parameters (minus `except`) and the typed locals. */
export function typedNames(params: readonly ParamInfo[], localNames: Iterable<string>, except?: string | null): Set<string> {
  const typed = new Set<string>(localNames);
  for (const p of params) if (p.type && p.name !== except) typed.add(p.name);
  return typed;
}

/** Sets (or clears) a function's writes and throws from what a plugin's reader found. */
export function applyEffects(fn: FunctionInfo, effects: Effects | null): void {
  if (effects?.fieldWrites) fn.fieldWrites = effects.fieldWrites;
  else delete fn.fieldWrites;
  if (effects?.throws) fn.throws = effects.throws;
  else delete fn.throws;
}

/** The facts one function states, capped and de-duplicated by receiver, member and line. */
export class EffectsCollector {
  private readonly writes: NonNullable<Effects["fieldWrites"]> = [];
  private readonly thrown: NonNullable<Effects["throws"]> = [];

  addWrite(receiver: string, member: string, line: number, init?: true, pkg?: true): void {
    if (this.writes.length >= MAX_FACTS) return;
    if (this.writes.some((w) => w.receiver === receiver && w.member === member && w.line === line)) return;
    this.writes.push({ member, receiver, line, ...(init ? { init } : {}), ...(pkg ? { package: pkg } : {}) });
  }

  get throwsFull(): boolean { return this.thrown.length >= MAX_FACTS; }

  addThrow(type: string, line: number, declared?: true): void {
    if (this.thrown.length >= MAX_FACTS) return;
    this.thrown.push({ type, line, ...(declared ? { declared } : {}) });
  }

  result(): Effects | null {
    if (this.writes.length === 0 && this.thrown.length === 0) return null;
    return { ...(this.writes.length > 0 ? { fieldWrites: this.writes } : {}), ...(this.thrown.length > 0 ? { throws: this.thrown } : {}) };
  }
}

/** Visits `root` and its named descendants in document order; a node `stop` accepts (other than the root) is neither visited nor entered. */
export function visitOwnScope(root: Node, stop: (n: Node) => boolean, visit: (n: Node) => void): void {
  const walk = (n: Node, isRoot: boolean): void => {
    if (!isRoot && stop(n)) return;
    visit(n);
    for (const c of n.namedChildren) walk(c, false);
  };
  walk(root, true);
}

/** The node and field names a grammar spells a member access with. */
export interface AccessShape { access: string; member: string; object: string; thisTypes: ReadonlySet<string> }

/** `this.x` / `a.x` / `this.a.x` / bare `x` in a C-family grammar. */
export function dottedTarget(left: Node | null | undefined, shape: AccessShape, typed: ReadonlySet<string>, locals: () => ReadonlySet<string>): WriteTarget | null {
  if (!left) return null;
  if (left.type === "identifier") return locals().has(left.text) ? null : { receiver: "", member: left.text };
  if (left.type !== shape.access) return null;
  const member = left.childForFieldName(shape.member);
  const obj = left.childForFieldName(shape.object);
  if (member?.type !== "identifier" || !obj) return null;
  if (shape.thisTypes.has(obj.type)) return { receiver: "this", member: member.text };
  if (obj.type === "identifier") return typed.has(obj.text) ? { receiver: obj.text, member: member.text } : null;
  if (obj.type === shape.access && shape.thisTypes.has(obj.childForFieldName(shape.object)?.type ?? "")) {
    const field = obj.childForFieldName(shape.member);
    return field?.type === "identifier" ? { receiver: `this.${field.text}`, member: member.text } : null;
  }
  return null;
}
