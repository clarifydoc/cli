import type { CallInfo, FileAnalysis, FunctionInfo, Language } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";
import { addDescriptorCalls } from "./descriptor-values.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * An RxJS subject a class feeds and listens to itself: a handler's `this.reload$.next(v)` runs what the same
 * class built from that subject — `this.reload$.pipe(debounceTime(300), switchMap(() => this.clubs.list())).subscribe(…)`,
 * also through an `x = this.reload$.asObservable()` alias. The `next` is a trigger: a call from the handler to each
 * project call the subscription statement makes (INFERRED, at the `next` line), so a click bound to the handler reaches
 * the request. Only subjects the class declares (`new Subject()` and its Behavior/Replay/Async kin), only subscribers in
 * the SAME class, only `this.`-rooted or bare calls — a callback parameter's methods are no project call.
 */
export function addSubjectTriggers(analysis: FileAnalysis, raw: string): void {
  if (!/\.next\s*\(/.test(raw) || !/\b(?:Subject|ReplaySubject|BehaviorSubject|AsyncSubject)\b/.test(raw)) return;
  const subjects = new Set<string>();
  for (const m of raw.matchAll(/(?<![\w$.])(?:(?:public|private|protected|readonly|static)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*new\s+(?:Subject|ReplaySubject|BehaviorSubject|AsyncSubject)\b/g)) subjects.add(m[1]!);
  if (subjects.size === 0) return;
  // Observable name → the subject it observes.
  const observed = new Map<string, string>([...subjects].map((s) => [s, s]));
  for (const m of raw.matchAll(/(?<![\w$.])(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*\.asObservable\s*\(\s*\)/g)) {
    if (subjects.has(m[2]!)) observed.set(m[1]!, m[2]!);
  }
  const rxjsNames = new Set(analysis.imports.filter((i) => /^rxjs(?:\/|$)/.test(i.source)).flatMap((i) => i.specifiers));
  const lineOf = lineIndex(raw);
  for (const cls of analysis.classes) {
    const methods = cls.methods ?? [];
    // subject → the calls its in-class subscribers make
    const reached = new Map<string, CallInfo[]>();
    const holderOf = new Map<string, Set<FunctionInfo>>();
    for (const [obs, subject] of observed) {
      const re = new RegExp(String.raw`(?<![\w$.])(?:this\.)?` + escapeRegex(obs) + String.raw`\s*\.(?:pipe|subscribe)\s*\(`, "g");
      for (const m of raw.matchAll(re)) {
        const from = lineNo(lineOf, m.index!);
        const holder = methods.filter((f) => f.line <= from && from <= f.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
        if (!holder) continue;
        const end = statementEnd(raw, m.index!);
        const statement = raw.slice(m.index!, end);
        if (!/\.subscribe\s*\(/.test(statement)) continue;
        const to = lineNo(lineOf, end - 1);
        const calls = holder.calls.filter((c) => c.line >= from && c.line <= to && isProjectCall(c, rxjsNames));
        if (calls.length === 0) continue;
        const list = reached.get(subject) ?? reached.set(subject, []).get(subject)!;
        for (const c of calls) list.push(c);
        // The holder itself is where the subscription is built, not a trigger of it.
        (holderOf.get(subject) ?? holderOf.set(subject, new Set()).get(subject)!).add(holder);
      }
    }
    for (const [subject, calls] of reached) {
      const re = new RegExp(String.raw`(?<![\w$.])(?:this\.)?` + escapeRegex(subject) + String.raw`\s*\.next\s*\(`, "g");
      for (const m of raw.matchAll(re)) {
        const at = lineNo(lineOf, m.index!);
        const fn = methods.filter((f) => f.line <= at && at <= f.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
        if (!fn || holderOf.get(subject)?.has(fn)) continue;
        for (const c of calls) {
          if (fn.calls.some((x) => x.name === c.name)) continue;
          fn.calls.push({ ...c, line: at, confidence: "INFERRED" });
        }
      }
    }
  }
}

/** A call that can be a project function: `this.clubs.list`, `search` — not an operator or a callback parameter's member. */
function isProjectCall(c: CallInfo, rxjsNames: Set<string>): boolean {
  const leaf = c.name.split(".").pop()!;
  if (/^(?:pipe|subscribe|asObservable|next|error|complete|unsubscribe)$/.test(leaf) || rxjsNames.has(c.name)) return false;
  return c.name.startsWith("this.") || !c.name.includes(".");
}

function lineIndex(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineNo(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The offset a chained statement ends at: a `;`, or a line break outside every bracket not followed by `.`. */
function statementEnd(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return i;
    } else if (depth === 0 && ch === ";") return i + 1;
    else if (depth === 0 && ch === "\n" && !/^\s*\./.test(source.slice(i + 1, i + 200))) return i;
  }
  return source.length;
}

/** Wraps another preprocess's outcome (or none) so the file's subjects and descriptor literals are read after extraction. */
export function withSubjectTriggers(outcome: PreprocessOutcome | { skip: string } | null, rawSource: string, language: Language): PreprocessOutcome | { skip: string } | null {
  if (outcome && "skip" in outcome) return outcome;
  const subjects = /\.next\s*\(/.test(rawSource) && /Subject\b/.test(rawSource);
  const descriptors = /\bclass\b/.test(rawSource) && /=\s*(?:\[\s*)?\{/.test(rawSource);
  if (!subjects && !descriptors) return outcome;
  const base: PreprocessOutcome = outcome ?? { sourceText: rawSource, language };
  return {
    ...base,
    postExtract(analysis, raw) {
      base.postExtract?.(analysis, raw);
      if (subjects) addSubjectTriggers(analysis, raw);
      if (descriptors) addDescriptorCalls(analysis, raw);
    },
  };
}
