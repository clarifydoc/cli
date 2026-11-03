import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
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
 * `testCase.subject`, and every block under it types `described_class` as it.
 */

const GROUPS = new Set(["describe", "context", "feature", "example_group", "xdescribe", "xcontext", "fdescribe", "fcontext"]);
const EXAMPLES = new Set(["it", "specify", "scenario", "example", "its", "xit", "fit", "xspecify", "xscenario", "focus", "pending", "skip"]);
const HOOKS = new Set(["before", "after", "around", "prepend_before", "append_after"]);

/** `RSpec.describe Club, type: :model do`, `it "orders" do |ex|`, `before(:each) do`, `it { … }`. */
const BLOCK = /^(\s*)(?:RSpec\s*\.\s*)?([a-z_]+)\b\s*(\(?)\s*(.*?)\s*\)?\s*(?:do(?:\s*\|[^|]*\|)?|\{(?:\s*\|[^|]*\|)?.*)\s*$/;

/** Cheap gate: a spec file names a group the RSpec way. */
const GATE = /^\s*(?:RSpec\s*\.\s*)?(?:describe|context|feature|shared_examples)\b/m;

/** A title as written: a quoted string unquoted, a constant (`Club`, `League::Table`) as its text. */
function titleOf(args: string): { title: string; subject?: string } | null {
  const first = args.match(/^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Z][\w]*(?:::[A-Z]\w*)*)|:(\w+[?!]?))/);
  if (!first) return null;
  const constant = first[3];
  const title = (first[1] ?? first[2] ?? constant ?? first[4] ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return constant ? { title, subject: constant } : { title };
}

/** The calls of `fromLine..toLine` (0-based, inclusive) less those on lines a nested block owns. */
function callsOver(code: readonly string[], from: number, to: number, owned: ReadonlySet<number>, prefixes: string[], patterns: CallPattern[]): CallInfo[] {
  const body = code.map((l, i) => (i < from || i > to || owned.has(i) ? "" : l));
  // The registration itself (`it`, `describe`) is the enclosing block's statement, not a call of this one.
  return extractCallsFromBody(body, from, to + 1, prefixes, patterns).filter((c) => !REGISTRATIONS.has(c.name.replace(/^RSpec\./, "")));
}

const REGISTRATIONS: ReadonlySet<string> = new Set([...GROUPS, ...EXAMPLES, ...HOOKS]);

/**
 * The spec file's groups, examples and hooks as functions, in source order,
 * appended to `fns`. A file with no RSpec group is returned as it was.
 */
export function rspecFunctions(lines: string[], fns: FunctionInfo[], callPatterns: CallPattern[]): FunctionInfo[] {
  if (!GATE.test(lines.join("\n"))) return fns;
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
  const out = [...fns];
  for (const b of blocks) {
    // Its own lines: the opening line is the enclosing block's statement, nested blocks are their own.
    // A block opened and closed on one line (`it { expect(club).to be_valid }`) keeps that line.
    const owned = new Set<number>(b.end > b.start ? [b.start] : []);
    for (const c of blocks) if (c !== b && c.start > b.start && c.end <= b.end) for (let i = c.start; i <= c.end; i++) owned.add(i);
    const path = pathOf(b);
    const subject = subjectOf(b);
    const fn: FunctionInfo = {
      // `::` would read as the `file::symbol` separator; the title itself stays as written.
      name: [...path, b.title].join(" › ").replace(/::/g, ":"),
      params: [],
      returnType: null,
      isAsync: false,
      isExported: false,
      decorators: [],
      calls: callsOver(code, b.start, b.end, owned, ["#"], callPatterns),
      line: b.start + 1,
      endLine: b.end + 1,
      testCase: { title: b.title, path, kind: b.kind, ...(b.kind === "suite" && b.subject ? { subject: b.subject } : {}) },
      ...(subject ? { localTypes: [{ name: "described_class", type: subject }] } : {}),
    };
    out.push(fn);
  }
  return out;
}
