import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector, MAX_FACTS } from "../shared/member-effects-kit.js";

const OP = String.raw`(?:\|\||&&|\*\*|<<|>>|[-+*/%|&^])?`;
const ASSIGN = String.raw`\s*${OP}=(?![=~>])`;
const ELEMENT = String.raw`(?:\[[^\]\n]*\])?`;
const IVAR_RE = new RegExp(String.raw`(?<![\w@$])@([a-z_]\w*)${ELEMENT}${ASSIGN}`, "g");
const IVAR_LIST_RE = /^\s*((?:@[a-z_]\w*\s*,\s*)+@[a-z_]\w*)\s*=(?![=~>])/;
const CVAR_RE = new RegExp(String.raw`(?<![\w@$])@@([a-z_]\w*)${ELEMENT}${ASSIGN}`, "g");
const SELF_RE = new RegExp(String.raw`(?<![\w.@$:])self\.([a-z_]\w*)${ELEMENT}${ASSIGN}`, "g");
const FIELD_RE = new RegExp(String.raw`(?<![\w@$])@([a-z_]\w*)\.([a-z_]\w*)${ELEMENT}${ASSIGN}`, "g");
const TYPED_RE = new RegExp(String.raw`(?<![\w.@$:])([a-z_]\w*)\.([a-z_]\w*)${ELEMENT}${ASSIGN}`, "g");
/** `raise Club::NotFound, …` / `fail Boom.new(…)` / `raise ::Boom`: a constant, then an argument list, `.new`, a modifier or the end. */
const RAISE_RE = /(?:^|[;{(]|\b(?:then|do|else)\b|\)\s)\s*(?:raise|fail)\b\s*\(?\s*(?:::)?([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)(?=\s*(?:[,)]|\.new\b|;|$|#|\s(?:if|unless|while|until)\b))/g;

/** The statements of a body as `[line, code]`, string literals blanked. */
type Body = ReadonlyArray<readonly [number, string]>;

/**
 * What a Ruby method writes to instance state and raises (`FunctionInfo.fieldWrites` / `throws`). Writes: `@name = n`,
 * `@name ||= compute` (a memoizing reader still assigns), `@name += 1`, `@items[k] = v`, `@a, @b = …`, `@@count += 1`
 * (member `@@count`), `self.name = n` (the writer method's attribute; core accepts it only where the class chain declares
 * `name`), `@club.name = n` (`this.club`) and `club.name = n` on a typed parameter or local. A class method's `@x` is
 * the class's own variable and states nothing; `initialize` states its `@x` writes as `init` declarations. Beside a
 * method's first write of `@x` an `init` row declares the member too (a Ruby class declares an instance variable by
 * assigning it), and so does every writer method (`attr_writer`, `def name=`): core never lists `init` rows. Raises:
 * `raise T, "msg"` / `raise T.new(…)` / `fail T` name the constant as written (`A::B` keeps its qualifier); `raise "text"`,
 * a variable and a bare `raise` state no type.
 */
export function rubyMemberEffects(body: Body, fn: FunctionInfo, typedNames: ReadonlySet<string>, ivars: Set<string> = new Set()): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const initializer = fn.name === "initialize" && !fn.classLevel;
  const instance = !fn.classLevel;
  for (const [index, raw] of body) {
    if (!/[=]|\b(?:raise|fail)\b/.test(raw)) continue;
    const code = blankStringLiterals(raw);
    const line = index + 1;
    if (!out.throwsFull && /\b(?:raise|fail)\b/.test(code)) {
      for (const m of code.matchAll(RAISE_RE)) {
        const type = m[1]!;
        if (/^[A-Z0-9_]+$/.test(type) && type.length > 1) continue;
        out.addThrow(type, line);
      }
    }
    if (!code.includes("=")) continue;
    if (instance) {
      for (const m of code.matchAll(IVAR_RE)) { ivars.add(m[1]!); out.addWrite("this", m[1]!, line, initializer ? true : undefined); }
      const list = IVAR_LIST_RE.exec(code);
      if (list) for (const n of list[1]!.split(",")) { const name = n.trim().slice(1); ivars.add(name); out.addWrite("this", name, line, initializer ? true : undefined); }
      if (!initializer) {
        for (const m of code.matchAll(SELF_RE)) out.addWrite("this", m[1]!, line);
        for (const m of code.matchAll(FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, line);
      }
    }
    for (const m of code.matchAll(CVAR_RE)) { ivars.add(`@@${m[1]}`); out.addWrite("this", `@@${m[1]}`, line); }
    if (initializer) continue;
    for (const m of code.matchAll(TYPED_RE)) if (typedNames.has(m[1]!)) out.addWrite(m[1]!, m[2]!, line);
  }
  return out.result();
}

/** The names a method states a type for: its typed parameters and its locals with a stated type. */
function typedOf(fn: FunctionInfo): Set<string> {
  const names = new Set<string>();
  for (const p of fn.params) if (p.type) names.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.field && !l.soft && l.choice === undefined) names.add(l.name);
  return names;
}

/**
 * Fills `fieldWrites` / `throws` on every method of `cls` and adds the declarations core joins writes on: an `init`
 * row for each writer method's attribute and for each instance variable, on the method whose line first assigns it.
 * `bodyOf` gives a method's body lines (one-line methods included).
 */
export function addRubyMemberEffects(cls: ClassInfo, bodyOf: (fn: FunctionInfo) => Body): void {
  const declared = new Set<string>();
  const declare = (fn: FunctionInfo, member: string): void => {
    if (declared.has(member)) return;
    declared.add(member);
    if (fn.fieldWrites?.some((w) => w.init && w.member === member)) return;
    const rows = (fn.fieldWrites ??= []);
    if (rows.length < MAX_FACTS * 2) rows.push({ member, receiver: "this", line: fn.line, init: true });
  };
  const assigned = new Map<FunctionInfo, Set<string>>();
  for (const fn of cls.methods) {
    if (fn.testCase || fn.classLevel) continue;
    const ivars = new Set<string>();
    const effects = rubyMemberEffects(bodyOf(fn), fn, typedOf(fn), ivars);
    assigned.set(fn, ivars);
    if (effects?.fieldWrites) fn.fieldWrites = effects.fieldWrites;
    if (effects?.throws) fn.throws = effects.throws;
  }
  const methods = cls.methods.filter((m) => !m.classLevel && !m.testCase);
  for (const fn of methods) {
    const writer = /^([a-z_]\w*)=$/.exec(fn.name);
    if (writer) declare(fn, writer[1]!);
  }
  for (const fn of methods) {
    for (const member of assigned.get(fn) ?? []) declare(fn, member);
  }
}
