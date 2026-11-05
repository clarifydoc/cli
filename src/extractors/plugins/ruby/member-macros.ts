import type { CallInfo, ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { splitTopLevel } from "../shared/regex-base.js";

/**
 * Members a class gets from a macro rather than a `def`: the readers and writers of `attr_*` and
 * `cattr_*`/`mattr_*`/`class_attribute`, Active Support's `delegate` and Forwardable's `def_delegator(s)`,
 * `alias_method`/`alias`, `define_method`. Each becomes a synthetic method, so a call on the class (or a bare call
 * inside it) has a definition to land on. A delegating member carries the call it makes on its target, which the
 * linker follows like any receiver chain (the target's type comes from an association or a typed reader — the
 * `reconcileProject` pass of the entity extractor adds the association readers, with the model each returns).
 *
 * A member the class declares itself with `def` wins; nothing here guesses at a name the macros do not state.
 */

const NAME = String.raw`[A-Za-z_]\w*[?!]?`;

/** The names a macro's symbol/string arguments list: `:a, :b`, `"a"`, `%i[a b]`. */
function listedNames(args: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(args)) {
    const t = part.trim();
    const sym = /^:(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*[?!]?))$/.exec(t) ?? /^["']([^"']+)["']$/.exec(t);
    if (sym) {
      const n = (sym[1] ?? sym[2] ?? sym[3])!;
      if (/^[A-Za-z_]\w*[?!]?$/.test(n)) out.push(n);
      continue;
    }
    const words = /^%[iw][[({<]([^\])}>]*)[\])}>]$/.exec(t);
    if (words) for (const w of words[1]!.split(/\s+/)) if (/^[A-Za-z_]\w*[?!]?$/.test(w)) out.push(w);
  }
  return out;
}

/** A keyword option's value in a macro's argument text: `to: :club`, `prefix: true`, `:to => :club`. */
function option(args: string, key: string): string | null {
  const m = new RegExp(String.raw`(?:\b${key}:|:${key}\s*=>)\s*(:[@\w?!]+|"[^"]*"|'[^']*'|true|false|nil|[@\w.]+)`).exec(args);
  return m ? m[1]! : null;
}

/** The statement starting at line `i`, joined over trailing commas and open brackets. */
function statementAt(lines: readonly string[], i: number, last: number): { text: string; end: number } {
  let text = (lines[i] ?? "").replace(/\s#.*$/, "");
  let j = i;
  const open = (t: string): number => [...t].reduce((d, ch) => d + ("{[(".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0), 0);
  while ((/[,\\]\s*$/.test(text) || open(text) > 0) && j < last && j - i < 20) text += " " + (lines[++j] ?? "").replace(/\s#.*$/, "").trim();
  return { text, end: j };
}

/** The lines of `cls` that are its own: not a method's body, not a nested class's. */
function ownLines(cls: ClassInfo, classes: readonly ClassInfo[], limit: number): number[] {
  const nested = classes.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
  const out: number[] = [];
  for (let i = cls.line; i < limit; i++) {
    const n = i + 1;
    if (nested.some((c) => n >= c.line && n <= c.endLine)) continue;
    if (cls.methods.some((m) => !m.synthetic && n >= m.line && n <= m.endLine && m.endLine > m.line)) continue;
    out.push(i);
  }
  return out;
}

/**
 * Adds the synthetic methods the macros in `cls`'s own body declare. Idempotent per name: an existing method
 * (written, a scope) is never replaced.
 */
export function addMacroMembers(lines: readonly string[], cls: ClassInfo, classes: readonly ClassInfo[]): void {
  const limit = Math.min(cls.endLine, lines.length);
  const have = new Set(cls.methods.map((m) => (m.classLevel ? `self.${m.name}` : m.name)));
  const add = (name: string, line: number, endLine: number, macro: string, extra: Partial<FunctionInfo> = {}): FunctionInfo | null => {
    const key = extra.classLevel ? `self.${name}` : name;
    if (have.has(key)) return null;
    have.add(key);
    const fn: FunctionInfo = { name, params: [], returnType: null, isAsync: false, isExported: true, decorators: [macro], calls: [], line, endLine, synthetic: true, ...extra };
    cls.methods.push(fn);
    return fn;
  };
  const skipTo = new Set<number>();
  for (const i of ownLines(cls, classes, limit)) {
    if (skipTo.has(i)) continue;
    const raw = lines[i] ?? "";
    const head = /^\s*(attr_reader|attr_writer|attr_accessor|cattr_reader|cattr_writer|cattr_accessor|mattr_reader|mattr_writer|mattr_accessor|class_attribute|delegate|def_delegators?|def_instance_delegators?|alias_method|alias|define_method)\b/.exec(raw);
    if (!head) continue;
    const macro = head[1]!;
    const stmt = statementAt(lines, i, limit - 1);
    for (let k = i + 1; k <= stmt.end; k++) skipTo.add(k);
    const line = i + 1;
    const endLine = stmt.end + 1;
    const args = stmt.text.slice(head[0].length).replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();

    if (/^(?:c|m)?attr_|^class_attribute$/.test(macro)) {
      const classLevel = /^(?:c|m)attr_|^class_attribute$/.test(macro);
      const reads = !/writer$/.test(macro);
      const writes = !/reader$/.test(macro);
      // A class-level attribute is also read through an instance (`instance_accessor`, on by default).
      for (const n of listedNames(args.replace(/,?\s*(?:\w+:|:\w+\s*=>)\s*[^,]+$/, ""))) {
        for (const level of classLevel ? [true, false] : [false]) {
          const extra: Partial<FunctionInfo> = level ? { classLevel: true } : {};
          if (reads) add(n, line, endLine, macro, extra);
          if (writes) add(`${n}=`, line, endLine, macro, extra);
        }
      }
      continue;
    }

    if (macro === "delegate") {
      const to = option(args, "to");
      if (!to || /^(?:true|false|nil)$/.test(to)) continue;
      const target = to.replace(/^[:"']+|["']+$/g, "").replace(/^@/, "");
      if (!/^[a-z_]\w*$/.test(target)) continue;
      const prefixOpt = option(args, "prefix");
      const prefix = prefixOpt === "true" ? target : prefixOpt && prefixOpt !== "false" && prefixOpt !== "nil" ? prefixOpt.replace(/^[:"']+|["']+$/g, "") : "";
      const ivar = to.replace(/^[:"']+/, "").startsWith("@");
      for (const n of listedNames(args.replace(/,?\s*(?:\w+:|:\w+\s*=>).*$/, ""))) {
        delegating(add, ivar, target, n, prefix ? `${prefix}_${n}` : n, line, endLine, macro);
      }
      continue;
    }

    if (/^def_(?:instance_)?delegators?$/.test(macro)) {
      const parts = splitTopLevel(args).map((p) => p.trim());
      const targetName = /^(?::|["'])?(@?[a-z_]\w*)["']?$/.exec(parts[0] ?? "")?.[1];
      if (!targetName) continue;
      const ivar = targetName.startsWith("@");
      const target = targetName.replace(/^@/, "");
      if (/delegators$/.test(macro)) {
        for (const n of listedNames(parts.slice(1).join(","))) delegating(add, ivar, target, n, n, line, endLine, macro);
      } else {
        const [method, as] = listedNames(parts.slice(1).join(","));
        if (method) delegating(add, ivar, target, method, as ?? method, line, endLine, macro);
      }
      continue;
    }

    if (macro === "alias_method" || macro === "alias") {
      const names = macro === "alias"
        ? new RegExp(String.raw`^:?(${NAME})\s*,?\s*:?(${NAME})\s*$`).exec(args)
        : new RegExp(String.raw`^:?["']?(${NAME})["']?\s*,\s*:?["']?(${NAME})["']?\s*$`).exec(args);
      if (!names) continue;
      const [, created, original] = names;
      const fn = add(created!, line, endLine, macro);
      if (fn && created !== original) fn.calls.push({ name: original!, kind: "internal", target: null, line });
      continue;
    }

    if (macro === "define_method") {
      const n = /^(?::|["'])([A-Za-z_]\w*[?!]?)["']?/.exec(args)?.[1];
      if (n) add(n, line, endLine, macro);
    }
  }
}

/** A member forwarding to `target`: one call on it, which the linker types by the target's own type. */
function delegating(
  add: (name: string, line: number, endLine: number, macro: string, extra?: Partial<FunctionInfo>) => FunctionInfo | null,
  ivar: boolean,
  target: string,
  method: string,
  as: string,
  line: number,
  endLine: number,
  macro: string,
): void {
  const fn = add(as, line, endLine, macro);
  if (!fn) return;
  const call: CallInfo = { name: `${target}.${method}`, kind: "internal", target: null, line };
  fn.calls.push(call);
  // A reader of the class itself (association, `def target`): its own typed member, as `self.target` reads it.
  if (!ivar) fn.localTypes = [{ name: target, type: "", from: `self.${target}()` }];
}
