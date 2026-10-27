/**
 * A verb call on a receiver that holds a collection another function built is
 * a lookup, not a request: `short.get('/sitemap.xml')` where
 * `const short = distinctLabels(…)` and `distinctLabels` is declared to return
 * a `Map`. The per-file pass refuses receivers its own file declares as a
 * collection (`new Map()`, `: Set<…>`); a function of another file it cannot
 * see. This project pass reads the local's initializer (`localTypes[].from`),
 * follows the called name to its declaration (same file, or the file the name
 * is imported from) and drops the row when that function's declared return
 * type is a `Map`/`Set` (also `ReadonlyMap`, `WeakMap`, …).
 */
import type { FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

const COLLECTION_TYPE_RE = /^(?:Readonly|Weak)?(?:Map|Set)\s*(?:<|$)/;
/** The verbs a Map or Set shares with an HTTP client. */
const COLLECTION_VERBS = new Set(["get", "delete"]);

/** The innermost-first functions whose span holds `line`, then the file's `<setup>`. */
function scopesAt(analysis: FileAnalysis, line: number): FunctionInfo[] {
  const fns = [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)];
  const holding = fns.filter((f) => f.name !== "<setup>" && f.line <= line && line <= (f.endLine ?? f.line)).sort((a, b) => b.line - a.line);
  const setup = analysis.functions.find((f) => f.name === "<setup>");
  return setup ? [...holding, setup] : holding;
}

function returnsCollection(analysis: FileAnalysis, callee: string, ctx: ProjectContext): boolean {
  const own = analysis.functions.find((f) => f.name === callee && f.returnType);
  if (own) return COLLECTION_TYPE_RE.test(own.returnType!);
  const file = ctx.importIndex.localFor(analysis.filePath, callee);
  const declared = file ? ctx.fileOf(file)?.functions.find((f) => f.name === callee) : undefined;
  return !!declared?.returnType && COLLECTION_TYPE_RE.test(declared.returnType);
}

/**
 * Drop the api-call rows made on a local holding a collection another function returned.
 *
 * @returns How many rows were dropped
 */
export function dropCollectionLookups(calls: ProjectApiCall[], ctx: ProjectContext): number {
  let dropped = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (call.kind !== "api-call" || !COLLECTION_VERBS.has(call.name) || !call.client || !/^[A-Za-z_$][\w$]*$/.test(call.client)) continue;
    const analysis = ctx.fileOf(call.filePath);
    if (!analysis || (analysis.language !== "typescript" && analysis.language !== "javascript")) continue;
    let local: { from?: string } | undefined;
    for (const scope of scopesAt(analysis, call.line)) {
      local = scope.localTypes?.find((l) => l.name === call.client);
      if (local) break;
    }
    const callee = /^([A-Za-z_$][\w$]*)\(\)$/.exec(local?.from ?? "")?.[1];
    if (!callee || !returnsCollection(analysis, callee, ctx)) continue;
    calls.splice(i, 1);
    const rows = analysis.dataSources;
    const at = rows.findIndex((r) => r.kind === "api-call" && r.line === call.line && r.name === call.name && r.client === call.client && r.target === call.target);
    if (at >= 0) rows.splice(at, 1);
    dropped++;
  }
  return dropped;
}
