import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { blankStringAwareComments } from "../shared/text-scan.js";

/**
 * An Aura component's script files are one parenthesised object literal each — `aura/clubList/clubListController.js`
 * is `({ handleSave: function (component, event, helper) { … } })`, with `…Helper.js` and `…Renderer.js` beside it —
 * which no declaration names, so the file holds no function. Read as `var clubListController = { … };` (the
 * wrapper swapped for spaces, so lines and the columns of every later line hold), each member is the function
 * `clubListController.handleSave`; the markup's `{!c.handleSave}` and the `helper.save(component)` of a handler are
 * joined to them by the Aura resolver that sits with the markup plugin.
 *
 * A server action is asked for by name: `component.get("c.promoteClub")` — a call in the function holding it, at that
 * line, to `aura-action:promoteClub` (a target no file bears; the markup plugin's resolver reads it).
 */

const AURA_SCRIPT = /^((?:.*\/)?aura\/([^/]+)\/)\2(Controller|Helper|Renderer)\.js$/;

/** What a call to the platform's server action carries in its `target`. */
export const AURA_ACTION_TARGET = "aura-action:";
/** What a call of a helper function — `helper.save(component)` — carries: the helper is found by the folder, never by the name. */
const AURA_HELPER_TARGET = "aura-helper:";

const ACTION = /\.get\(\s*(["'])c\.([A-Za-z_]\w*)\1\s*\)/g;

function swapWrapper(raw: string, name: string): string | null {
  const blank = blankStringAwareComments(raw);
  const open = /^\s*\(\s*\{/.exec(blank);
  if (!open) return null;
  const parenAt = blank.indexOf("(");
  const close = blank.lastIndexOf(")");
  if (close < parenAt || blank.slice(close + 1).replace(/[;\s]/g, "") !== "") return null;
  const head = `var ${name} = `;
  // The opening paren and the head share the first line's room: columns on it shift, no later line does.
  return raw.slice(0, parenAt) + head + raw.slice(parenAt + 1, close) + " " + raw.slice(close + 1);
}

function innermost(fns: readonly FunctionInfo[], line: number): FunctionInfo | undefined {
  let best: FunctionInfo | undefined;
  for (const f of fns) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line) best = f;
  }
  return best;
}

function addActionCalls(analysis: FileAnalysis, raw: string, isHelper: boolean, name: string): void {
  const own = new Set(analysis.functions.map((f) => f.name));
  // `helper.save(…)` (and the helper's own `this.save(…)`) names a member of the folder's helper object, which no
  // other file's `save` is: the call is the resolver's, so the name tiers never guess a namesake for it.
  for (const fn of analysis.functions) {
    for (const call of fn.calls) {
      const m = /^(helper|this)\.([A-Za-z_]\w*)$/.exec(call.name);
      if (!m || (m[1] === "this" && (!isHelper || !own.has(`${name}.${m[2]!}`)))) continue;
      call.kind = "cross-file";
      call.target = `${AURA_HELPER_TARGET}${m[2]!}`;
    }
  }
  const blank = blankStringAwareComments(raw);
  for (const m of blank.matchAll(ACTION)) {
    const before = raw.slice(0, m.index);
    const line = before.split("\n").length;
    const owner = innermost(analysis.functions, line);
    if (!owner) continue;
    const column = m.index! - (before.lastIndexOf("\n") + 1);
    const call: CallInfo = { name: `c.${m[2]!}`, kind: "cross-file", target: `${AURA_ACTION_TARGET}${m[2]!}`, line, column, argCount: 1, confidence: "EXTRACTED" };
    owner.calls.push(call);
  }
}

/** The outcome that reads an Aura controller, helper or renderer script, or null for any other file. */
export function auraScriptPreprocess(raw: string, path: string): PreprocessOutcome | null {
  const m = AURA_SCRIPT.exec(path);
  if (!m) return null;
  const name = `${m[2]}${m[3]}`;
  const text = swapWrapper(raw, name);
  if (text === null) return null;
  return { sourceText: text, language: "javascript", postExtract: (analysis, source) => addActionCalls(analysis, source, m[3] === "Helper", name) };
}
