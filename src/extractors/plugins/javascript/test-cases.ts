import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../../../types/analysis.js";

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
export function testCaseFunctions(root: Node, sourceText: string, build: (name: string, fn: Node, skip: (node: Node) => boolean) => FunctionInfo): FunctionInfo[] {
  if (!GATE.test(sourceText)) return [];
  const out: FunctionInfo[] = [];
  /** A registration this file turns into a function: the callback, its kind and title; null for any other node. */
  const registered = (node: Node): { reg: string; callback: Node; title: string } | null => {
    if (node.type !== "call_expression") return null;
    const reg = registrationName(node.childForFieldName("function"));
    if (!reg) return null;
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    const callback = args.find(isFunction);
    if (!callback) return null;
    // A suite or case states its title first; a hook is named for its kind.
    const title = HOOKS.has(reg) ? reg : titleOf(args[0] === callback ? undefined : args[0]);
    return title ? { reg, callback, title } : null;
  };
  // A callback's body is read once, without the registrations below it: those are functions of
  // their own, each read once as its own body, so a suite carries only its own calls and locals.
  const skip = (node: Node): boolean => registered(node) !== null;
  const visit = (node: Node, path: string[]): void => {
    for (const child of node.namedChildren) {
      const found = registered(child);
      if (!found) {
        visit(child, path);
        continue;
      }
      const { reg, callback, title } = found;
      // `::` would read as the `file::symbol` separator; the title itself stays as written.
      const fn = build([...path, title].join(TEST_TITLE_SEPARATOR).replace(/::/g, ":"), callback, skip);
      fn.testCase = { title, path: [...path], kind: SUITES.has(reg) ? "suite" : HOOKS.has(reg) ? "hook" : "case" };
      out.push(fn);
      fn.calls = fn.calls.filter((c) => !TEST_REGISTRATION.has(c.name.split(".")[0]!));
      visit(callback, [...path, title]);
    }
  };
  visit(root, []);
  return out;
}
