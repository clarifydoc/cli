import type { Node } from "web-tree-sitter";
import type { ClassInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "./regex-base.js";

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

/** The names a function states the type of: its typed parameters and its locals typed by a stated type (not soft, not one arm of a choice). */
export function statedTypeNames(fn: FunctionInfo): Set<string> {
  return typedNames(fn.params, (fn.localTypes ?? []).filter((l) => l.type && !l.soft && l.choice === undefined).map((l) => l.name));
}

/** A function's lines for a regex reader: `raw` as written, `code` with strings and comments blanked, each line blanked once, on first use. */
export class BodyText {
  /** The last line of the body that the file has. */
  readonly last: number;
  private readonly blanked = new Map<number, string>();

  constructor(private readonly lines: readonly string[], readonly fn: FunctionInfo, private readonly commentMarkers: readonly string[]) {
    this.last = Math.min(fn.endLine, lines.length);
  }

  raw(ln: number): string { return this.lines[ln - 1] ?? ""; }

  code(ln: number): string {
    let code = this.blanked.get(ln);
    if (code === undefined) this.blanked.set(ln, (code = blankStringLiterals(this.raw(ln), this.commentMarkers)));
    return code;
  }
}

/** The names a function binds itself — its parameters and what `read` finds on each body line — read on the first call only. */
export function ownNames(body: BodyText, read: (code: string, add: (name: string) => void) => void): () => ReadonlySet<string> {
  let own: Set<string> | null = null;
  return () => {
    if (own) return own;
    const names = (own = new Set(body.fn.params.map((p) => p.name)));
    const add = (name: string): void => void names.add(name);
    for (let ln = body.fn.line; ln <= body.last; ln++) read(body.code(ln), add);
    return names;
  };
}

/** The names binding lists state (`let a`, `val (a, b)`, `{ a, b in`): each first capture of `res` split on `,`, `clean`ed, kept when a plain name and no keyword. */
export function addBindingNames(code: string, res: readonly RegExp[], clean: RegExp, keywords: ReadonlySet<string>, add: (name: string) => void): void {
  for (const re of res) {
    for (const m of code.matchAll(re)) for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(clean, "");
      if (/^[A-Za-z_]\w*$/.test(name) && !keywords.has(name)) add(name);
    }
  }
}

/**
 * The members a type's body declares at its own depth — `memberRe`'s first capture on a line outside its methods and
 * the types nested in it (`var visits = 0`, `private val repo: Repo`) — with the line of each.
 */
export function membersAtOwnDepth(lines: readonly string[], cls: ClassInfo, all: readonly ClassInfo[], memberRe: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  const end = Math.min(cls.endLine, lines.length + 1);
  if (end <= cls.line + 1) return out;
  const covered = new Uint8Array(end - cls.line);
  const cover = (s: { line: number; endLine: number }): void => {
    for (let ln = Math.max(s.line, cls.line + 1); ln <= Math.min(s.endLine, end - 1); ln++) covered[ln - cls.line] = 1;
  };
  for (const m of cls.methods) cover(m);
  for (const c of all) if (c !== cls && c.line > cls.line && c.endLine <= cls.endLine) cover(c);
  for (let ln = cls.line + 1; ln < end; ln++) {
    if (covered[ln - cls.line]) continue;
    const m = memberRe.exec(lines[ln - 1] ?? "");
    if (m && !out.has(m[1]!)) out.set(m[1]!, ln);
  }
  return out;
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
  private readonly declared = new Set<string>();

  addWrite(receiver: string, member: string, line: number, init?: true, pkg?: true, cls?: string): void {
    if (this.writes.length >= MAX_FACTS) return;
    if (this.writes.some((w) => w.receiver === receiver && w.member === member && w.line === line && w.class === cls)) return;
    this.writes.push({ member, receiver, line, ...(init ? { init } : {}), ...(pkg ? { package: pkg } : {}), ...(cls ? { class: cls } : {}) });
  }

  /** States a member's declaration — an `init` write on `this` at `line` — once per function; line 0 (a member core knows already) states nothing. */
  declareOnce(member: string, line: number | undefined): void {
    if (line === undefined || this.declared.has(member)) return;
    this.declared.add(member);
    if (line > 0) this.addWrite("this", member, line, true);
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
