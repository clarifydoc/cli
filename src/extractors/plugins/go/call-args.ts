import type { CallInfo, ClassInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * A composite literal's address handed straight to a call — `handler.DoReadAll(ctx,
 * &models.Club{}, a)` — says which type the callee receives, as a local
 * built from it would (`club := &models.Club{}`); a value literal (`gin.H{…}`)
 * is a payload, not a receiver of methods, and is not recorded. Such calls record their
 * arguments (`CallInfo.args`): the literal as `&models.Club{…}`, every other
 * argument as "". A generic handler dispatching on an interface parameter is
 * then bound per call site. Calls handing no composite literal record nothing.
 */
const LITERAL = /^(&\s*[A-Za-z_]\w*(?:\.[A-Z]\w*)?)\s*\{/;

/** The balanced argument text of the call whose `(` is at `open`, or null when it does not close. */
function argText(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    } else if (ch === '"' || ch === "`") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) return null;
      i = end;
    }
  }
  return null;
}

/** A call's argument text split at its top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (ch === '"' || ch === "`") {
      const end = args.indexOf(ch, i + 1);
      cur += args.slice(i, end + 1);
      i = end < 0 ? args.length : end;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function addArgs(lines: string[], calls: CallInfo[]): void {
  for (const call of calls) {
    const line = lines[call.line - 1];
    if (!line?.includes("{")) continue;
    const at = line.indexOf(`${call.name}(`);
    if (at < 0 || /[\w.]/.test(line[at - 1] ?? "")) continue;
    const text = lines.slice(call.line - 1, call.line + 19).join("\n");
    const inner = argText(text, at + call.name.length);
    if (inner === null) continue;
    const args = splitArgs(inner).map((a) => {
      const m = LITERAL.exec(a);
      return m ? `${m[1]!.replace(/\s+/g, "")}{…}` : "";
    });
    if (args.some((a) => a !== "")) call.args = args;
  }
}

/** Every function's calls handing a composite literal record their arguments. */
export function withCompositeArgs(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  for (const fn of fns) addArgs(lines, fn.calls);
  return fns;
}

/** As `withCompositeArgs`, for the methods attached to their structs. */
export function withCompositeArgsInClasses(lines: string[], classes: ClassInfo[]): ClassInfo[] {
  for (const cls of classes) for (const m of cls.methods) addArgs(lines, m.calls);
  return classes;
}
