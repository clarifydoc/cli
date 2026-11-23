import type { CallPattern } from "../shared/regex-base.js";

/**
 * Spellings the Apex plugin reads in more than one file — declaration heads, annotations, the inline-query opener, the
 * two call shapes. A leaf: no import of the plugin's other modules.
 */

/** One annotation as written: `@AuraEnabled`, `@RestResource(urlMapping='/clubs/*')`. */
export const ANNOTATION = String.raw`@\w+(?:\([^)]*\))?`;
/** Zero or more annotations, each followed by whitespace. */
export const ANNOTATIONS = String.raw`(?:${ANNOTATION}\s+)*`;

/** Modifiers a class declaration takes. */
export const CLASS_MODIFIERS = String.raw`(?:(?:global|public|private|protected|virtual|abstract|static|final|with[ \t]+sharing|without[ \t]+sharing|inherited[ \t]+sharing)[ \t]+)*`;

/** Words a type position never holds (a statement keyword, not a declaration). */
const STATEMENT_WORDS = "return|new|else|throw|insert|update|upsert|delete|undelete|merge|if|for|while|catch|switch|do|try|when|case|and|or|not|instanceof";
/** A declaration's type cannot be one of these (lookahead). */
export const KEYWORD_TYPE = String.raw`(?!(?:${STATEMENT_WORDS}|trigger|class|interface|enum)\b)`;

/** `trigger ClubTrigger on Club__c (` — the head up to the event list's opening parenthesis. */
const TRIGGER_OPEN = String.raw`^\s*trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)\s*\(`;
/** A trigger's first line: name, object and the event list (groups 1-3). */
export const TRIGGER_HEAD = new RegExp(String.raw`${TRIGGER_OPEN}([^)]*)\)`, "i");
/** Whether a line opens a trigger declaration (the event list may run on). */
export const TRIGGER_FN = new RegExp(TRIGGER_OPEN, "i");

/** An inline query opens `[SELECT` or `[FIND` (the verb is group 1). */
const QUERY_OPEN = /^\[\s*(SELECT|FIND)\b/i;

/** The verb of the inline query opening at `at`, or null when none does. */
export function queryOpensAt(text: string, at: number): "SELECT" | "FIND" | null {
  const verb = QUERY_OPEN.exec(text.slice(at, at + 24))?.[1];
  return verb ? (verb.toUpperCase() as "SELECT" | "FIND") : null;
}

const classCall = (m: RegExpExecArray) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! });

/** `ClubService.promote(club)`: a capitalized receiver is a class, so a static call on it. */
export const STATIC_CALL: CallPattern = { pattern: /(?<![\w.])([A-Z]\w*)\.([A-Za-z_]\w*)\s*\(/, buildName: classCall };
/** `new ClubService().promote(club)`: the method of the class just constructed. */
export const NEW_CALL: CallPattern = {
  pattern: /\bnew\s+([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/i,
  buildName: classCall,
};

/** The innermost of `spans` holding `line` (smallest extent; the first of equals). */
export function innermost<T extends { line: number; endLine: number }>(spans: readonly T[], line: number): T | undefined {
  let best: T | undefined;
  for (const s of spans) {
    if (s.line <= line && line <= s.endLine && (!best || s.endLine - s.line < best.endLine - best.line)) best = s;
  }
  return best;
}
