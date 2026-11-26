/**
 * Reads `aura/<n>/<n>Controller|Helper|Renderer.js` as `var <n>Controller = { … }` (the parenthesised object swapped
 * for a declaration, lines kept), turns `component.get("c.saveClub")` into a call to `aura-action:saveClub`,
 * `component.getEvent("clubSelected")` into one to `aura-event:clubSelected`, `$A.get("e.c:leagueRefreshed")` into
 * one to `aura-app-event:leagueRefreshed` and `helper.x` / the helper's `this.x` into `aura-helper:x`; no name tier
 * guesses them. The joins are the markup plugin's `SfMarkupResolver`.
 */

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
 * line, to `aura-action:promoteClub` (a target no file bears; the markup plugin's resolver reads it). An event the
 * script fires is stated the same way: `component.getEvent("clubSelected")` → `aura-event:clubSelected`,
 * `$A.get("e.c:leagueRefreshed")` → `aura-app-event:leagueRefreshed`.
 */

const AURA_SCRIPT = /^((?:.*\/)?aura\/([^/]+)\/)\2(Controller|Helper|Renderer)\.js$/;

/** What a call to the platform's server action carries in its `target`. */
export const AURA_ACTION_TARGET = "aura-action:";
/** What a call of a helper function — `helper.save(component)` — carries: the helper is found by the folder, never by the name. */
const AURA_HELPER_TARGET = "aura-helper:";

const ACTION = /\.get\(\s*(["'])c\.([A-Za-z_]\w*)\1\s*\)/g;

/** What a component event a script gets to fire carries — `component.getEvent("clubSelected")`: the parent binding it answers. */
export const AURA_EVENT_TARGET = "aura-event:";
/** What an application event carries — `$A.get("e.c:leagueRefreshed")`: every component handling it answers. */
export const AURA_APP_EVENT_TARGET = "aura-app-event:";

const COMPONENT_EVENT = /\.getEvent\(\s*(["'])([A-Za-z_]\w*)\1\s*\)/g;
const APP_EVENT = /\$A\s*\.\s*get\(\s*(["'])e\.(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)\1\s*\)/g;

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
  const stated = (re: RegExp, name: (m: RegExpMatchArray) => string, target: (m: RegExpMatchArray) => string): void => {
    for (const m of blank.matchAll(re)) {
      const before = raw.slice(0, m.index);
      const line = before.split("\n").length;
      const owner = innermost(analysis.functions, line);
      if (!owner) continue;
      const column = m.index! - (before.lastIndexOf("\n") + 1);
      const call: CallInfo = { name: name(m), kind: "cross-file", target: target(m), line, column, argCount: 1, confidence: "EXTRACTED" };
      owner.calls.push(call);
    }
  };
  stated(ACTION, (m) => `c.${m[2]!}`, (m) => `${AURA_ACTION_TARGET}${m[2]!}`);
  // An event the script gets is the one it fires (`getEvent("x").fire()`, or set its params first): the handlers run.
  stated(COMPONENT_EVENT, (m) => `fire:${m[2]!}`, (m) => `${AURA_EVENT_TARGET}${m[2]!}`);
  stated(APP_EVENT, (m) => `fire:e.${m[2]!}`, (m) => `${AURA_APP_EVENT_TARGET}${m[2]!}`);
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
