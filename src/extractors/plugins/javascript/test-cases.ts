import type { Node } from "web-tree-sitter";
import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * A test runner's registrations (mocha, jest, vitest, jasmine, node:test): their callbacks run
 * when the runner says, each a test of its own — never the module's setup.
 */
export const TEST_REGISTRATION: ReadonlySet<string> = new Set([
  "describe", "it", "test", "suite", "context", "beforeEach", "afterEach", "beforeAll", "afterAll", "before", "after", "fdescribe", "xdescribe", "fit", "xit",
]);

const SUITES: ReadonlySet<string> = new Set(["describe", "suite", "context", "fdescribe", "xdescribe"]);
const HOOKS: ReadonlySet<string> = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll", "before", "after"]);
/** `it.only`, `describe.skip`, `test.concurrent.each`: modifiers that keep the registration what it is. */
const MODIFIERS: ReadonlySet<string> = new Set(["only", "skip", "todo", "concurrent", "sequential", "fails", "each", "failing", "runIf", "skipIf"]);

/** Cheap gate: the file names a registration as a call (`it(`, `describe.each(`), not as a member (`re.test(`). */
const GATE = /(?<![\w$.])(?:describe|it|test|suite|context|fdescribe|xdescribe|fit|xit)(?:\.\w+)*\s*\(/;

/** The registration a callee names: `it`, `it.only`, `test.each(table)`, `describe.skip.each(rows)` → its base name. */
function registrationName(callee: Node | null): string | null {
  let at = callee;
  // `test.each(table)("adds %i", fn)`: the callee is itself a call of the modified registration.
  if (at?.type === "call_expression") {
    const inner = at.childForFieldName("function");
    if (inner?.type !== "member_expression") return null;
    at = inner;
  }
  while (at?.type === "member_expression") {
    if (!MODIFIERS.has(at.childForFieldName("property")?.text ?? "")) return null;
    at = at.childForFieldName("object");
  }
  return at?.type === "identifier" && TEST_REGISTRATION.has(at.text) ? at.text : null;
}

/** A title as written: a string or template literal unquoted, any other expression (`Club.name`) as its text. */
function titleOf(arg: Node | undefined): string | null {
  if (!arg) return null;
  if (arg.type === "string" || (arg.type === "template_string" && arg.namedChildren.every((c) => c.type === "string_fragment" || c.type === "escape_sequence"))) {
    return arg.text.slice(1, -1).replace(/\s+/g, " ").trim() || null;
  }
  if (arg.type === "template_string") return arg.text.slice(1, -1).replace(/\s+/g, " ").trim() || null;
  return /^(?:identifier|member_expression)$/.test(arg.type) ? arg.text : null;
}

const isFunction = (n: Node): boolean => n.type === "arrow_function" || n.type === "function_expression";

/** Joins a test's title path into the function name the analysis knows it by (`league › leader › finds the top club`). */
export const TEST_TITLE_SEPARATOR = " › ";

/**
 * Every test-runner callback in the file as a function of its own — suites, cases and hooks at any
 * nesting — named by its title path (`league › builds`, `league › beforeEach`), with the calls its
 * own body makes (a suite's body without its nested callbacks', which are functions of their own)
 * and `testCase` saying what it is. `build` turns the callback into a `FunctionInfo` the way the
 * extractor builds any function expression.
 */
export function testCaseFunctions(root: Node, sourceText: string, build: (name: string, fn: Node) => FunctionInfo): FunctionInfo[] {
  if (!GATE.test(sourceText)) return [];
  const out: FunctionInfo[] = [];
  // Returns the calls of every callback registered below `node`, as each was built: the enclosing
  // callback's own body reached into them (an inline callback's calls are its encloser's), and
  // they are a function of their own, so the encloser gives them up.
  const visit = (node: Node, path: string[]): CallInfo[] => {
    const nested: CallInfo[] = [];
    for (const child of node.namedChildren) {
      if (child.type === "call_expression") {
        const reg = registrationName(child.childForFieldName("function"));
        const args = reg ? (child.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment") : [];
        const callback = args.find(isFunction);
        if (reg && callback) {
          const hook = HOOKS.has(reg);
          // A suite or case states its title first; a hook is named for its kind.
          const title = hook ? reg : titleOf(args[0] === callback ? undefined : args[0]);
          if (title) {
            // `::` would read as the `file::symbol` separator; the title itself stays as written.
            const fn = build([...path, title].join(TEST_TITLE_SEPARATOR).replace(/::/g, ":"), callback);
            fn.testCase = { title, path: [...path], kind: SUITES.has(reg) ? "suite" : hook ? "hook" : "case" };
            out.push(fn);
            nested.push(...fn.calls);
            fn.calls = without(fn.calls, visit(callback, [...path, title])).filter((c) => !TEST_REGISTRATION.has(c.name.split(".")[0]!));
            continue;
          }
        }
      }
      nested.push(...visit(child, path));
    }
    return nested;
  };
  visit(root, []);
  return out;
}

/** `calls` less one occurrence of each of `taken` (by name and line). */
function without(calls: CallInfo[], taken: readonly CallInfo[]): CallInfo[] {
  if (!taken.length) return calls;
  const left = new Map<string, number>();
  for (const c of taken) left.set(`${c.name}\0${c.line}`, (left.get(`${c.name}\0${c.line}`) ?? 0) + 1);
  return calls.filter((c) => {
    const k = `${c.name}\0${c.line}`;
    const n = left.get(k) ?? 0;
    if (n === 0) return true;
    left.set(k, n - 1);
    return false;
  });
}
