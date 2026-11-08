import type { FileAnalysis } from "../../../types/analysis.js";
import { propFunctionName } from "./markup-calls.js";

/**
 * A Vue SFC function that only writes a ref (`function findUser(q) { userSearch.value = q }`)
 * re-runs whatever the component built from that ref at setup — a composable
 * handed it (`useUserSearch(userSearch)`), which runs the query. The write is
 * that composable's trigger: a call from the function to it, at the write's
 * line, so a template handler bound to the function reaches the request.
 * Only refs the script declares (`ref(…)`/`shallowRef(…)`), only composables
 * (`useX`) called at the script's top level with the ref among their arguments.
 */
export function addReactiveTriggers(analysis: FileAnalysis, raw: string): void {
  const found = reactiveUsers(analysis, raw);
  if (!found) return;
  const { lines, users } = found;
  addScriptTriggers(analysis, lines, users);
  addTemplateTriggers(analysis, users);
}

/**
 * An inline template write (`@page="currentPage = $event"`, `@click="open = true"`) to a ref a query is
 * built from is the same trigger a function body's write is: the element's own calls name the composable
 * or factory, and the component's `<setup>` calls it at the element's line (INFERRED, as the function's is).
 * A write that can only switch a gating `enabled` flag off triggers nothing.
 */
function addTemplateTriggers(analysis: FileAnalysis, users: Users): void {
  for (const el of analysis.interactiveElements) {
    if (!el.handler) continue;
    for (const [r, composables] of users) {
      const write = new RegExp(`(?<![\\w$.])${r}\\s*=(?![=>])([^;]*)`).exec(el.handler);
      if (!write) continue;
      for (const c of composables) {
        if (c.gate && DISABLING.test(write[1]!)) continue;
        if (el.calls?.includes(c.name)) continue;
        let setup = analysis.functions.find((f) => f.name === "<setup>");
        if (!setup) {
          setup = { name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: 1, endLine: 1 };
          analysis.functions.unshift(setup);
        }
        const imp = analysis.imports.find((i) => i.specifiers.includes(c.name));
        (el.calls ??= []).push(c.name);
        const call = { name: c.name, kind: imp ? "cross-file" as const : "internal" as const, target: imp?.source ?? null, line: el.line, column: 1, argCount: 1, confidence: "INFERRED" as const };
        if (!setup.calls.some((x) => x.name === c.name && x.line === el.line)) setup.calls.push(call);
        // A child's event bound to the write alone: the binding is a function of its own (the one a call-spelling
        // binding gets from `markupFunctions`), holding the trigger, so the child's emit reaches it.
        if (el.element === "custom" && el.component && el.event.startsWith("@") && !/[\w$]\s*\(/.test(el.handler)) {
          const name = propFunctionName(el.component, el.event, el.line);
          let bound = analysis.functions.find((f) => f.name === name);
          if (!bound) analysis.functions.push((bound = { name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: el.line, endLine: el.line }));
          if (!bound.calls.some((x) => x.name === c.name)) bound.calls.push({ ...call });
        }
      }
    }
  }
}

type Users = Map<string, Array<{ name: string; line: number; gate: boolean }>>;

/** A value only a switch-off writes: `false`, `null`, `undefined`, `''`, `0`. */
const DISABLING = /^\s*(?:false|null|undefined|''|""|``|0)\s*;?\s*(?:\/\/.*)?$/;

/** Whether every mention of the ref in the hook's arguments is its `enabled:` flag (`enabled: open.value`, `enabled: open`). */
function isGateOnly(ref: string, text: string): boolean {
  const all = [...text.matchAll(new RegExp(`(?<![\\w$.])${ref}(?![\\w$])`, "g"))].length;
  const gates = [...text.matchAll(new RegExp(`\\benabled\\s*:\\s*${ref}(?:\\.value)?(?![\\w$.])`, "g"))].length;
  return all > 0 && all === gates;
}

/** The refs the script declares, and for each the composables / query factories built from it at setup. */
function reactiveUsers(analysis: FileAnalysis, raw: string): { lines: string[]; users: Users } | undefined {
  if (!raw.includes(".value") && !raw.includes("<template")) return undefined;
  const lines = raw.split("\n");
  const refs = new Set<string>();
  for (const line of lines) {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef)\s*(?:<[^>]*>)?\s*\(/.exec(line);
    if (m) refs.add(m[1]!);
  }
  if (refs.size === 0) return undefined;
  // Top-level composable calls, by the refs they read.
  const users = new Map<string, Array<{ name: string; line: number; gate: boolean }>>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:const|let)\s+[^=]+=\s*(use[A-Z][\w$]*)\s*\(/.exec(lines[i]!);
    if (!m || /^use(?:Mutation|Infinite)?Mutation$/.test(m[1]!)) continue;
    // Its arguments: this line and the next few, up to the statement's end.
    let text = lines[i]!.slice(m.index + m[0].length);
    for (let j = i + 1; j < lines.length && j - i < 6 && !/^\S/.test(lines[j]!); j++) text += "\n" + lines[j]!;
    // A library query hook (`useQuery(computed(() => adminUserSearchQuery(search.value)))`): the
    // project's query factories called in its arguments are what runs.
    const project = (name: string) => analysis.imports.some((imp) => imp.specifiers.includes(name) && /^[./]|\//.test(imp.source) && !imp.source.startsWith("@tanstack/"));
    const runs = project(m[1]!) ? [m[1]!] : [...text.matchAll(/(?:^|[^\w$.]|\.\.\.)([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]!).filter(project);
    for (const r of refs) {
      if (!new RegExp(`(?<![\\w$.])${r}(?![\\w$])`).test(text)) continue;
      // A ref the arguments only name as the request's `enabled` flag can switch the request off by a write, never run it.
      const gate = isGateOnly(r, text);
      for (const name of new Set(runs)) (users.get(r) ?? users.set(r, []).get(r)!).push({ name, line: i + 1, gate });
    }
  }
  return users.size === 0 ? undefined : { lines, users };
}

function addScriptTriggers(analysis: FileAnalysis, lines: string[], users: Users): void {
  for (const fn of analysis.functions) {
    if (fn.name === "<setup>") continue;
    for (let l = fn.line; l <= fn.endLine && l <= lines.length; l++) {
      for (const [r, composables] of users) {
        const write = new RegExp(`(?<![\\w$.])${r}\\.value\\s*=(?!=)(.*)`).exec(lines[l - 1]!);
        if (!write) continue;
        for (const c of composables) {
          if (c.gate && DISABLING.test(write[1]!)) continue;
          if (fn.calls.some((x) => x.name === c.name)) continue;
          const imp = analysis.imports.find((i) => i.specifiers.includes(c.name));
          fn.calls.push({ name: c.name, kind: imp ? "cross-file" : "internal", target: imp?.source ?? null, line: l, column: 1, argCount: 1, confidence: "INFERRED" });
        }
      }
    }
  }
}
