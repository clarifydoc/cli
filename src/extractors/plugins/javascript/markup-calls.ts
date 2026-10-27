import type { CallInfo, FunctionInfo, InteractiveElementInfo } from "../../../types/analysis.js";

/** Single-file components whose template sits outside every script function. */
const SFC = /\.(?:vue|svelte)$/;
const CHAIN = /^[\w$]+(?:\.[\w$]+)*$/;
const CALLEE = /(?:^|[^\w$.])([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\(/g;
/** Not calls of project code: the emit a dispatch resolver joins, keywords, globals. */
const SKIP = /^(?:\$?emit|if|for|while|switch|return|function|typeof|await|new|void|console\..*|JSON\..*|Math\..*|Object\..*|Array\..*|String|Number|Boolean|alert|confirm|setTimeout|clearTimeout|parseInt|parseFloat)$/;

/**
 * What a Vue/Svelte template's handlers call: `@click="markAllRead"` names a
 * function (often one destructured from a composable, which nothing in the
 * script calls), `@save="store.actions.updateOne($event)"` calls one, and an
 * inline `(club) => { save(club); close() }` calls each callee it spells. JSX
 * handlers sit inside the component function already, so other files give none.
 */
export function markupCalls(elements: readonly InteractiveElementInfo[], filePath: string, declared?: ReadonlySet<string>): CallInfo[] {
  if (!SFC.test(filePath)) return [];
  const out: CallInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, line: number) => {
    if (SKIP.test(name) || name.startsWith("$") || seen.has(`${line}\0${name}`)) return;
    seen.add(`${line}\0${name}`);
    out.push({ name, kind: "internal", target: null, line });
  };
  for (const el of elements) {
    const handler = el.handler?.trim();
    // A function handed down as a prop, or bound to a child's event, is its own function (`markupFunctions`).
    if (!handler || isPropFunction(el) || isEventFunction(el, declared)) continue;
    const bare = handler.replace(/^(?:void|await)\s+/, "");
    if (CHAIN.test(bare)) {
      add(bare, el.line);
      continue;
    }
    for (const m of handler.matchAll(CALLEE)) add(m[1]!, el.line);
  }
  return out;
}

/** A function the markup hands a component as a prop (`:add="(club) => …"`). */
function isPropFunction(el: InteractiveElementInfo): boolean {
  return el.element === "custom" && !!el.component && el.event.startsWith(":");
}

/**
 * A child's event bound to anything but one of the file's own functions
 * (`@delete-one="unitActions.deleteOne"`, `@delete="actions.deleteOne($event)"`,
 * `@save="(club) => store.save(club)"`, `@save="saveItem"` destructured from a
 * composable): what the binding calls is a function of its own, which the emit
 * resolver joins the child's emit to. A handler naming a function the file
 * declares (`@save="onSave"`, `onSave($event)` — `declared`) is that function
 * already, and one that passes the event on (`$emit('save', car)`) is followed
 * up the parents.
 */
export function isEventFunction(el: InteractiveElementInfo, declared?: ReadonlySet<string>): boolean {
  if (el.element !== "custom" || !el.component || !el.event.startsWith("@") || !el.handler) return false;
  const handler = el.handler.trim();
  const bare = BARE_HANDLER.exec(handler)?.[1];
  if (bare && (!declared || declared.has(bare))) return false;
  return !REEMIT_HANDLER.test(handler) && eventCalls(handler).length > 0;
}

/** `onSave`, `onSave($event)`, `void onSave()`: a function called by its bare name. */
const BARE_HANDLER = /^(?:void\s+|await\s+)?([A-Za-z_$][\w$]*)\s*(?:\(.*\))?$/s;
/** An event passed on: `$emit('save', car)`, `(car) => emit('save', car)`. */
const REEMIT_HANDLER = /^(?:(?:\([^()]*\)|[\w$]+)\s*=>\s*)?\$?emit\s*\(/;

/** The project calls an event binding spells: each callee, or the member a bare reference names. */
function eventCalls(handler: string): string[] {
  const bare = handler.replace(/^(?:void|await)\s+/, "");
  const names = CHAIN.test(bare) ? [bare] : [...handler.matchAll(CALLEE)].map((m) => m[1]!);
  return [...new Set(names)].filter((name) => !SKIP.test(name) && !name.startsWith("$"));
}

/** The name of the function a prop or event binding defines: `<ClubList:add@14>`, `<ClubList@delete@14>`. */
export function propFunctionName(component: string, event: string, line: number): string {
  return `<${component}${event}@${line}>`;
}

/**
 * The functions a Vue/Svelte template hands components as props: each inline
 * function is a function of its own, named for its tag, prop and line, holding
 * the calls its body spells — what runs when the child calls the prop. A
 * child's event bound to an expression is one too (`isEventFunction`).
 */
export function markupFunctions(elements: readonly InteractiveElementInfo[], filePath: string, declared?: ReadonlySet<string>): FunctionInfo[] {
  if (!SFC.test(filePath)) return [];
  const out: FunctionInfo[] = [];
  for (const el of elements) {
    if (isEventFunction(el, declared)) {
      const calls = eventCalls(el.handler!.trim()).map((name): CallInfo => ({ name, kind: "internal", target: null, line: el.line }));
      out.push({ name: propFunctionName(el.component!, el.event, el.line), params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls, line: el.line, endLine: el.line });
      continue;
    }
    if (!isPropFunction(el) || !el.handler) continue;
    const calls: CallInfo[] = [];
    const seen = new Set<string>();
    for (const m of el.handler.matchAll(CALLEE)) {
      const name = m[1]!;
      if (SKIP.test(name) || name.startsWith("$") || seen.has(name)) continue;
      seen.add(name);
      calls.push({ name, kind: "internal", target: null, line: el.line });
    }
    out.push({ name: propFunctionName(el.component!, el.event, el.line), params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls, line: el.line, endLine: el.line });
  }
  return out;
}
