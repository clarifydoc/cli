import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
import { heldCallsOf } from "../../shared/call-graph.js";
import { extractCallsFromBody, type CallPattern } from "../shared/regex-base.js";
import { rubyBlockEndsOf, rubyCodeLinesOf } from "./blocks.js";

/**
 * RSpec's blocks as functions. A spec file declares no methods: its examples
 * are `it "…" do … end` blocks the runner calls, so without them a spec calls
 * nothing and no change is ever credited to it. Each group (`describe`,
 * `context`, `feature`), example (`it`, `specify`, `scenario`, `example`) and
 * hook (`before`, `after`, `around`) becomes a function named by its title path
 * (`Club › .rank › orders by points`), with the calls its own lines make —
 * a group's `let` and `subject` blocks are its own, its nested blocks are not.
 * A group describing a constant (`RSpec.describe Club do`) says so in
 * `testCase.subject`, and every block under it types `described_class` as it —
 * and each name a `let` / `subject` binds to `described_class.new(…)` or
 * `Club.new(…)`, so `service.perform` (in Ruby a call, parentheses or not) is a
 * call of the class's method.
 */

const GROUPS = new Set(["describe", "context", "feature", "example_group", "xdescribe", "xcontext", "fdescribe", "fcontext"]);
const EXAMPLES = new Set(["it", "specify", "scenario", "example", "its", "xit", "fit", "xspecify", "xscenario", "focus", "pending", "skip"]);
const HOOKS = new Set(["before", "after", "around", "prepend_before", "append_after"]);

/**
 * `RSpec.describe Club, type: :model do`, `it "orders" do |ex|`, `before(:each) do`, `it { … }` — never a
 * hash key named like one (`scenario: {` in a `let`'s hash).
 */
const BLOCK = /^(\s*)(?:RSpec\s*\.\s*)?([a-z_]+)\b(?!:)\s*(\(?)\s*(.*?)\s*\)?\s*(?:do(?:\s*\|[^|]*\|)?|\{(?:\s*\|[^|]*\|)?.*)\s*$/;

/** Cheap gate: a spec file names a group the RSpec way. */
const GATE = /^\s*(?:RSpec\s*\.\s*)?(?:describe|context|feature|shared_examples)\b/;

/** A title as written: a quoted string unquoted, a constant (`Club`, `League::Table`) as its text. */
function titleOf(args: string): { title: string; subject?: string } | null {
  const first = args.match(/^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Z][\w]*(?:::[A-Z]\w*)*)|:(\w+[?!]?))/);
  if (!first) return null;
  const constant = first[3];
  const title = (first[1] ?? first[2] ?? constant ?? first[4] ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return constant ? { title, subject: constant } : { title };
}

/** `described_class` as written — never a member (`x.described_class`) or a longer name. */
const DESCRIBED = /(?<![\w.@$:])described_class\b/g;
const DESCRIBED_LENGTH = "described_class".length;

/** A line with `described_class` spelled as the constant a block types it as (its `localTypes`), as the call scan reads it. */
export function withDescribedClass(line: string, fn: FunctionInfo): string {
  if (!line.includes("described_class")) return line;
  const subject = fn.localTypes?.find((l) => l.name === "described_class")?.type;
  return subject ? line.replace(DESCRIBED, subject) : line;
}

/**
 * The calls of `fromLine..toLine` (0-based, inclusive) less those on lines a nested block owns.
 * `described_class` is the described constant itself, so a call through it is read as a call on
 * that constant (`described_class.new(…)` → `League::Club.new`) at the column it is written.
 */
function callsOver(code: readonly string[], from: number, to: number, owned: ReadonlySet<number>, prefixes: string[], patterns: CallPattern[], subject: string | undefined): CallInfo[] {
  const shifts = new Map<number, number[]>();
  const body = code.map((l, i) => {
    if (i < from || i > to || owned.has(i)) return "";
    if (!subject || !l.includes("described_class")) return l;
    const at: number[] = [];
    const text = l.replace(DESCRIBED, (_m, offset: number) => {
      at.push(offset + at.length * (subject.length - DESCRIBED_LENGTH));
      return subject;
    });
    shifts.set(i + 1, at);
    return text;
  });
  // The registration itself (`it`, `describe`) is the enclosing block's statement, not a call of this one.
  // Removed in place: the member calls held back as noise (`League::Club.new`) are kept against
  // this array, and come back once the file's classes are known (`restoreTypedReceiverCalls`).
  const calls = extractCallsFromBody(body, from, to + 1, prefixes, patterns);
  for (let i = calls.length - 1; i >= 0; i--) if (REGISTRATIONS.has(calls[i]!.name.replace(/^RSpec\./, ""))) calls.splice(i, 1);
  if (shifts.size) {
    // Back to the columns as written; held calls are the same objects, so they come back right too.
    const fix = (c: CallInfo) => {
      const at = shifts.get(c.line);
      if (at && c.column !== undefined) c.column -= at.filter((x) => x < c.column!).length * (subject!.length - DESCRIBED_LENGTH);
    };
    calls.forEach(fix);
    heldCallsOf(calls).forEach(fix);
  }
  return calls;
}

const REGISTRATIONS: ReadonlySet<string> = new Set([...GROUPS, ...EXAMPLES, ...HOOKS]);

/** `let(:service) { … }`, `let!(:club) do`, `subject(:job) { … }`, `subject { … }`: the name and what follows the opening. */
const LET = /^\s*(let!?|subject!?)\s*(?:\(\s*:(\w+[?!]?)\s*\))?\s*(?:\{(.*)|do\s*(?:\|[^|]*\|)?\s*$)/;
const CONST = String.raw`[A-Z]\w*(?:::[A-Z]\w*)*`;
/**
 * What a `let` builds, read from its first statement: `described_class.new(…)`, `Club.new(…)` — a
 * whole statement (its arguments may run on to the next lines), never one opening a block (`Struct.new(:id) do … end.new`), and never an
 * anonymous class or record (`Class.new(Base)`, `Struct.new`), whose methods are its block's.
 */
const BUILDS = new RegExp(String.raw`^\s*(?:(described_class)|(?!(?:Class|Module|Struct|Data)\.)(${CONST}))\.new\b(?:\s*\((?:[^()]|\([^()]*\))*\)|\s*\(\s*)?\s*\}?\s*$`);

/**
 * The names a group binds on its own lines, each with the type its block builds (`described_class.new`
 * → the described class, `Club.new` → `Club`) or null when the block says nothing of one.
 */
function ownLets(code: readonly string[], from: number, to: number, owned: ReadonlySet<number>, subject: string | undefined): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  for (let i = from; i <= to; i++) {
    if (owned.has(i)) continue;
    const m = code[i]!.match(LET);
    if (!m) continue;
    const name = m[2] ?? (m[1]!.startsWith("subject") ? "subject" : null);
    if (!name) continue;
    let body = m[3];
    for (let j = i + 1; body === undefined && j <= to; j++) if (code[j]!.trim()) body = code[j]!;
    const built = BUILDS.exec(body ?? "");
    out.push([name, built ? (built[1] ? subject ?? null : built[2]!) : null]);
  }
  return out;
}

/**
 * The spec file's groups, examples and hooks as functions, in source order,
 * appended to `fns`. A file with no RSpec group is returned as it was.
 */
export function rspecFunctions(lines: string[], fns: FunctionInfo[], callPatterns: CallPattern[]): FunctionInfo[] {
  if (!lines.some((l) => GATE.test(l))) return fns;
  const code = rubyCodeLinesOf(lines);
  const ends = rubyBlockEndsOf(lines);
  interface Block { start: number; end: number; kind: "suite" | "case" | "hook"; title: string; subject?: string; parent: Block | null; }
  const blocks: Block[] = [];
  const stack: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    while (stack.length && stack[stack.length - 1]!.end < i) stack.pop();
    const m = code[i]!.match(BLOCK);
    if (!m) continue;
    const word = m[2]!;
    const kind = GROUPS.has(word) ? "suite" : EXAMPLES.has(word) ? "case" : HOOKS.has(word) ? "hook" : null;
    if (!kind) continue;
    // A top-level example or hook outside any group is no RSpec (a Rake `before`, a Sinatra filter).
    if (kind !== "suite" && stack.length === 0) continue;
    const end1 = ends.get(i);
    const end = end1 !== undefined ? end1 - 1 : i;
    // The title is read from the raw line: the code lines keep quoted strings, but not every form.
    const raw = lines[i]!.match(BLOCK);
    const named = kind === "hook" ? { title: word } : titleOf((raw?.[4] ?? m[4] ?? "").trim());
    // A group is always titled; `context = build do` is an assignment.
    if (kind === "suite" && !named) continue;
    const block: Block = {
      start: i,
      end,
      kind,
      // An untitled example (`it { is_expected.to … }`) is named for its line.
      title: named?.title ?? `example at line ${i + 1}`,
      ...(named && "subject" in named && named.subject ? { subject: named.subject } : {}),
      parent: stack[stack.length - 1] ?? null,
    };
    blocks.push(block);
    stack.push(block);
  }
  if (!blocks.length) return fns;
  const pathOf = (b: Block): string[] => (b.parent ? [...pathOf(b.parent), b.parent.title] : []);
  const subjectOf = (b: Block | null): string | undefined => (b ? b.subject ?? subjectOf(b.parent) : undefined);
  // The lines each block owns: its own, less the opening line (the enclosing block's statement) and
  // its nested blocks. A block opened and closed on one line (`it { expect(club).to be_valid }`) keeps that line.
  const ownedOf = new Map<Block, Set<number>>();
  for (const b of blocks) {
    const owned = new Set<number>(b.end > b.start ? [b.start] : []);
    for (const c of blocks) if (c !== b && c.start > b.start && c.end <= b.end) for (let i = c.start; i <= c.end; i++) owned.add(i);
    ownedOf.set(b, owned);
  }
  // The names a group's `let` / `subject` bind, typed where the block builds the described class or a
  // constant; a nested group sees its ancestors' and may rebind one (to a type nobody can tell: null).
  const letsOf = new Map<Block, Map<string, string | null>>();
  const scopeOf = (b: Block | null): Map<string, string | null> => {
    if (!b) return new Map();
    const known = letsOf.get(b);
    if (known) return known;
    const scope = new Map(scopeOf(b.parent));
    if (b.kind === "suite") for (const [name, type] of ownLets(code, b.start, b.end, ownedOf.get(b)!, subjectOf(b))) scope.set(name, type);
    letsOf.set(b, scope);
    return scope;
  };
  // The names typed inside a block: `described_class`, and the `let`s built from a known class.
  const typedOf = (b: Block): Map<string, string> => {
    const subject = subjectOf(b);
    const typed = new Map<string, string>(subject ? [["described_class", subject]] : []);
    for (const [name, type] of scopeOf(b)) {
      if (type) typed.set(name, type);
      else typed.delete(name);
    }
    return typed;
  };
  // A helper `def` written in a group sees what the group types: `described_class` and its `let`s
  // are methods it can call, unless it binds the name itself.
  for (const fn of fns) {
    let inner: Block | null = null;
    for (const b of blocks) if (b.start < fn.line - 1 && fn.endLine - 1 <= b.end && (!inner || b.start > inner.start)) inner = b;
    if (!inner) continue;
    const own = new Set([...fn.params.map((p) => p.name), ...(fn.localTypes ?? []).map((l) => l.name)]);
    const seen = [...typedOf(inner)].filter(([name]) => !own.has(name)).map(([name, type]) => ({ name, type }));
    if (seen.length) fn.localTypes = [...(fn.localTypes ?? []), ...seen];
  }
  const out = [...fns];
  for (const b of blocks) {
    const owned = ownedOf.get(b)!;
    const path = pathOf(b);
    const subject = subjectOf(b);
    const typed = typedOf(b);
    // Member calls on the names typed here (`service.perform`) are the plugin's typed-call passes', as in any method.
    const calls = callsOver(code, b.start, b.end, owned, ["#"], callPatterns, subject);
    const fn: FunctionInfo = {
      // `::` would read as the `file::symbol` separator; the title itself stays as written.
      name: [...path, b.title].join(" › ").replace(/::/g, ":"),
      params: [],
      returnType: null,
      isAsync: false,
      isExported: false,
      decorators: [],
      calls,
      line: b.start + 1,
      endLine: b.end + 1,
      testCase: { title: b.title, path, kind: b.kind, ...(b.kind === "suite" && b.subject ? { subject: b.subject } : {}) },
      ...(typed.size ? { localTypes: [...typed].map(([name, type]) => ({ name, type })) } : {}),
    };
    out.push(fn);
  }
  return out;
}
