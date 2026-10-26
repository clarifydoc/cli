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
export function markupCalls(elements: readonly InteractiveElementInfo[], filePath: string): CallInfo[] {
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
    // A function handed down as a prop is its own function (`markupFunctions`).
    if (!handler || isPropFunction(el)) continue;
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

/** The name of the function a prop binding defines: `<ClubList:add@14>`. */
export function propFunctionName(component: string, event: string, line: number): string {
  return `<${component}${event}@${line}>`;
}

/**
 * The functions a Vue/Svelte template hands components as props: each inline
 * function is a function of its own, named for its tag, prop and line, holding
 * the calls its body spells — what runs when the child calls the prop.
 */
export function markupFunctions(elements: readonly InteractiveElementInfo[], filePath: string): FunctionInfo[] {
  if (!SFC.test(filePath)) return [];
  const out: FunctionInfo[] = [];
  for (const el of elements) {
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
