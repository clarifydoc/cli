import type { ClassInfo, FileAnalysis, FunctionInfo, ValueFlowFact } from "../../../types/analysis.js";

/** A closure handler's pseudo-name: `<onPressed@218>`. */
const CLOSURE_NAME = /^<on\w+@\d+>$/;

/**
 * A closure handed to a widget event (`onPressed: () { onSave(club); }`, `onTap: () => widget.onSelect?.call(club)`,
 * `onLongPress: () => onLongPress!(club)`) is a pseudo-function of its own holding its calls — and so the parser's
 * `invoke` facts for those calls, which sit on the method around it, must also stand on the closure: the call it
 * makes runs whatever the parent passed to the callback field, and the name tiers must not take it for a function of
 * that name elsewhere. Each fact is copied from the innermost function that contains the closure, for the calls the
 * closure itself makes (at the closure's own line), and the closure is marked as written in that method's class so a
 * field cell (`this.onSave`, `widget.onSelect`) is the class's.
 */
export function closureValueFlow(analysis: FileAnalysis): void {
  const closures = analysis.functions.filter((f) => CLOSURE_NAME.test(f.name) && f.calls.length > 0);
  if (closures.length === 0) return;
  const candidates: Array<{ fn: FunctionInfo; cls: ClassInfo | null }> = [];
  for (const cls of analysis.classes) for (const m of cls.methods) candidates.push({ fn: m, cls });
  for (const fn of analysis.functions) if (!CLOSURE_NAME.test(fn.name) && fn.name !== "<setup>") candidates.push({ fn, cls: null });
  for (const closure of closures) {
    let owner: { fn: FunctionInfo; cls: ClassInfo | null } | null = null;
    for (const c of candidates) {
      if (!c.fn.valueFlow?.length || c.fn.line > closure.line || c.fn.endLine < closure.endLine) continue;
      if (!owner || c.fn.endLine - c.fn.line < owner.fn.endLine - owner.fn.line) owner = c;
    }
    if (!owner) continue;
    const facts: ValueFlowFact[] = [];
    for (const f of owner.fn.valueFlow!) {
      if (f.kind !== "invoke") continue;
      const own = closure.calls.find((c) => c.name === f.call);
      if (own) facts.push({ ...f, line: own.line });
    }
    if (facts.length === 0) continue;
    closure.valueFlow = [...(closure.valueFlow ?? []), ...facts];
    if (owner.cls) closure.enclosingClass = owner.cls.name;
  }
}
