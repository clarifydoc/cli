import type { FileAnalysis } from "../../../types/analysis.js";

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
  if (!raw.includes(".value")) return;
  const lines = raw.split("\n");
  const refs = new Set<string>();
  for (const line of lines) {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef)\s*(?:<[^>]*>)?\s*\(/.exec(line);
    if (m) refs.add(m[1]!);
  }
  if (refs.size === 0) return;
  // Top-level composable calls, by the refs they read.
  const users = new Map<string, Array<{ name: string; line: number }>>();
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
      for (const name of new Set(runs)) (users.get(r) ?? users.set(r, []).get(r)!).push({ name, line: i + 1 });
    }
  }
  if (users.size === 0) return;
  for (const fn of analysis.functions) {
    if (fn.name === "<setup>") continue;
    for (let l = fn.line; l <= fn.endLine && l <= lines.length; l++) {
      for (const [r, composables] of users) {
        if (!new RegExp(`(?<![\\w$.])${r}\\.value\\s*=(?!=)`).test(lines[l - 1]!)) continue;
        for (const c of composables) {
          if (fn.calls.some((x) => x.name === c.name)) continue;
          const imp = analysis.imports.find((i) => i.specifiers.includes(c.name));
          fn.calls.push({ name: c.name, kind: imp ? "cross-file" : "internal", target: imp?.source ?? null, line: l, column: 1, argCount: 1, confidence: "INFERRED" });
        }
      }
    }
  }
}
