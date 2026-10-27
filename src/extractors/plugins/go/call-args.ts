import type { CallInfo, ClassInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * A composite literal's address handed straight to a call — `handler.DoReadAll(ctx,
 * &models.Club{}, a)` — says which type the callee receives, as a local
 * built from it would (`club := &models.Club{}`); a value literal (`gin.H{…}`)
 * is a payload, not a receiver of methods, and is not recorded. Such calls record their
 * arguments (`CallInfo.args`): the literal as `&models.Club{…}`, every other
 * argument as "". A field of a parameter addressed instead (`&in.Body.Club`, or a
 * local holding that address) stands for a literal of the field's type. A generic
 * handler dispatching on an interface parameter is then bound per call site. Calls
 * handing no composite literal record nothing.
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

/** Named struct types of the file: type name → field name → field type (an embedded field is named by its type). */
function structsOf(lines: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (let i = 0; i < lines.length; i++) {
    const head = /^type\s+([A-Za-z_]\w*)\s+struct\s*\{\s*$/.exec(lines[i]!);
    if (!head) continue;
    const fields = new Map<string, string>();
    for (let j = i + 1; j < lines.length && !/^\s*\}/.test(lines[j]!); j++) {
      const text = lines[j]!.replace(/`[^`]*`/g, "").replace(/\/\/.*$/, "").trim();
      const named = /^([A-Za-z_]\w*)\s+(\*?[\w.]+)$/.exec(text);
      const embedded = /^\*?((?:[a-z_]\w*\.)?([A-Z]\w*))$/.exec(text);
      if (named) fields.set(named[1]!, named[2]!);
      else if (embedded) fields.set(embedded[2]!, embedded[1]!);
    }
    out.set(head[1]!, fields);
  }
  return out;
}

/** The fields of a struct type as written: an anonymous `struct { ID int64 \`path:"id"\` Body models.Club }` or a named struct of the file. */
function fieldsOf(type: string, structs: Map<string, Map<string, string>>): Map<string, string> | null {
  const anonymous = /^struct\s*\{([\s\S]*)\}$/.exec(type.trim());
  if (!anonymous) return structs.get(type) ?? null;
  const fields = new Map<string, string>();
  for (const m of anonymous[1]!.replace(/`[^`]*`/g, " ").matchAll(/([A-Za-z_]\w*)\s+(\*?[\w.]+)/g)) fields.set(m[1]!, m[2]!);
  return fields;
}

/**
 * The struct an argument addresses through a parameter's fields —
 * `&in.Body.Label`, where `in` is `*struct{ Body labelBody }` and `labelBody`
 * embeds `models.Label` — as the composite literal it stands for
 * (`&models.Label{…}`); a local holding such an address (`label := &in.Body.Label`)
 * too. Null for anything else.
 */
function addressedType(arg: string, fn: FunctionInfo, locals: Map<string, string>, structs: Map<string, Map<string, string>>): string | null {
  const local = /^[A-Za-z_]\w*$/.test(arg) ? locals.get(arg) : undefined;
  const m = /^&([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)+)$/.exec(local ?? arg);
  if (!m) return null;
  let type = fn.params.find((p) => p.name === m[1])?.type?.replace(/^\*/, "") ?? null;
  for (const field of m[2]!.slice(1).split(".")) {
    const fields = type ? fieldsOf(type, structs) : null;
    type = fields?.get(field)?.replace(/^\*/, "") ?? null;
    if (!type) return null;
  }
  // A struct the file declares, or another package's exported type: never a builtin.
  return type && (structs.has(type) || /^[a-z_]\w*\.[A-Z]\w*$/.test(type)) ? `&${type}{…}` : null;
}

function addArgs(lines: string[], fn: FunctionInfo, structs: Map<string, Map<string, string>>): void {
  // Locals holding a field's address: `label := &in.Body.Label`.
  const locals = new Map<string, string>();
  for (let i = Math.max(0, (fn.line ?? 1) - 1); i < Math.min(lines.length, fn.endLine ?? lines.length); i++) {
    const m = /^\s*([A-Za-z_]\w*)\s*:=\s*(&[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*$/.exec(lines[i]!);
    if (m) locals.set(m[1]!, locals.has(m[1]!) ? "" : m[2]!);
  }
  for (const call of fn.calls) {
    const line = lines[call.line - 1];
    if (!line || (!line.includes("{") && !line.includes("&") && ![...locals.keys()].some((l) => new RegExp(`\\b${l}\\b`).test(line)))) continue;
    const at = line.indexOf(`${call.name}(`);
    if (at < 0 || /[\w.]/.test(line[at - 1] ?? "")) continue;
    const text = lines.slice(call.line - 1, call.line + 19).join("\n");
    const inner = argText(text, at + call.name.length);
    if (inner === null) continue;
    const args = splitArgs(inner).map((a) => {
      const m = LITERAL.exec(a);
      return m ? `${m[1]!.replace(/\s+/g, "")}{…}` : addressedType(a, fn, locals, structs) ?? "";
    });
    if (args.some((a) => a !== "")) call.args = args;
  }
}

/** Every function's calls handing a composite literal record their arguments. */
export function withCompositeArgs(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  const structs = structsOf(lines);
  for (const fn of fns) addArgs(lines, fn, structs);
  return fns;
}

/** As `withCompositeArgs`, for the methods attached to their structs. */
export function withCompositeArgsInClasses(lines: string[], classes: ClassInfo[]): ClassInfo[] {
  const structs = structsOf(lines);
  for (const cls of classes) for (const m of cls.methods) addArgs(lines, m, structs);
  return classes;
}
