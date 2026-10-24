import type { CallInfo, InteractiveElementInfo } from "../../../types/analysis.js";

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
    if (!handler) continue;
    const bare = handler.replace(/^(?:void|await)\s+/, "");
    if (CHAIN.test(bare)) {
      add(bare, el.line);
      continue;
    }
    for (const m of handler.matchAll(CALLEE)) add(m[1]!, el.line);
  }
  return out;
}
