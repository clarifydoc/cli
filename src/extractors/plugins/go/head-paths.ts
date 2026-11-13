import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { heldCallsOf } from "../../shared/call-graph.js";
import { stripGoComment } from "./syntax.js";

/** A selector path on one line — a name, then at least one `.name` — not the tail of a longer expression. */
const PATH_RE = /(?<![\w.)\]])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*\(/g;

/**
 * The regex scan names `a.b.c.M(` by its last two names (`c.M`, marked `receiverCut`). Where the path starts at a
 * value the function binds — its receiver, a parameter, a local — it is named by every name back to that head, as the
 * grammar reader does, so the linker types the receiver field by field from the head's type (`localTypes`): `c.Status.String(`
 * for `for _, c := range clubs { c.Status.String() }`. The receiver's own field (`s.repo.Find(`, three names from the
 * receiver) keeps the two names, as does a path from a package value or one split over lines. A path another
 * expression of the same line names differently (two heads end in the same two names) is left cut.
 */
export function withHeadPathNames(lines: readonly string[], fn: FunctionInfo, receiver: string | undefined, declared: ReadonlySet<string>): void {
  const heads = new Set(declared);
  const typedHeads = new Set<string>();
  for (const p of fn.params) if (p.name !== "_") { heads.add(p.name); typedHeads.add(p.name); }
  if (receiver && receiver !== "_") typedHeads.add(receiver);
  if (receiver && receiver !== "_") heads.add(receiver);
  if (heads.size === 0) return;
  const renamed: CallInfo[] = [];
  // The calls held back as noise (`String`, `Close`) are named the same way, in place: they are restored by array identity.
  for (const call of [...fn.calls, ...heldCallsOf(fn.calls)]) {
    if (call.passed || !call.receiverCut || call.name.split(".").length !== 2) continue;
    const text = lines[call.line - 1];
    if (!text || !text.includes(call.name.slice(call.name.indexOf(".")))) continue;
    const code = blankStringLiterals(stripGoComment(text));
    const paths = new Set<string>();
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(code)) !== null) {
      const ids = m[1]!.split(".");
      if (ids.length < 3 || `${ids.at(-2)}.${ids.at(-1)}` !== call.name) continue;
      const own = ids.length === 3 && ids[0] === receiver;
      paths.add(heads.has(ids[0]!) && !own ? m[1]! : call.name);
    }
    if (paths.size !== 1) continue;
    const [path] = [...paths];
    if (path === call.name) continue;
    // A path from a local keeps its two-name reading as the fallback (`CallInfo.fallbackName`): a local states no type.
    if (!typedHeads.has(path!.split(".")[0]!)) call.fallbackName = call.name;
    call.name = path!;
    delete call.receiverCut;
    renamed.push(call);
  }
  if (renamed.length === 0) return;
  // A renamed call that came to the name of another call is that call (removed in place: held calls are kept by the array's identity).
  const keyOf = (c: CallInfo): string => `${c.name}\0${c.passed ?? ""}\0${c.boundLocally ? 1 : 0}`;
  const seen = new Set(fn.calls.filter((c) => !renamed.includes(c)).map(keyOf));
  for (const call of renamed) {
    const at = fn.calls.indexOf(call);
    if (at < 0) continue;
    if (seen.has(keyOf(call))) fn.calls.splice(at, 1);
    else seen.add(keyOf(call));
  }
}
