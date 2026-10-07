import type { ClassInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import {
  attributeLinesAbove,
  extractCallsFromBody,
  extractParamsFromDeclaration,
  findEndLine,
  inlineBodyColumn,
} from "../shared/regex-base.js";
import { closeOf, codeOf } from "./di.js";

/**
 * Members the declaration-shaped function pattern cannot see, read only at a
 * class body's own depth — where `Name(` can only be a constructor and
 * `Type name(…);` only an abstract signature, never a call statement:
 *
 *   UserService(this._repo);                       constructor
 *   UserService(UserRepo repo) : _repo = repo;     constructor + initializer list
 *   Future<User?> load(int id);                    abstract method
 *
 * Constructors carry their parameters (a `this._repo` parameter takes the
 * field's type) — that is how an injected dependency is declared; abstract
 * signatures are what an interface's implementations are matched against.
 */
export function addBodyLevelMembers(lines: string[], cls: ClassInfo, spec: RegexLangSpec, parseParam: (t: string) => ParamInfo | null): void {
  const known = new Set(cls.methods.map((m) => m.line));
  const added: FunctionInfo[] = [];
  let brace = 0;
  let other = 0;
  let opened = false;
  const last = Math.min(cls.endLine, lines.length);
  for (let j = cls.line - 1; j < last; j++) {
    const code = codeOf(lines[j]!);
    if (opened && brace === 1 && other === 0 && !known.has(j + 1)) {
      const fn = memberAt(lines, j, code, cls, spec, parseParam);
      if (fn) added.push(fn);
    }
    for (const c of code) {
      if (c === "{") {
        brace++;
        opened = true;
      } else if (c === "}") brace--;
      else if (c === "(" || c === "[") other++;
      else if (c === ")" || c === "]") other = Math.max(0, other - 1);
    }
  }
  if (added.length === 0) return;
  cls.methods.push(...added);
  cls.methods.sort((a, b) => a.line - b.line);
  for (const m of added) {
    if (m.name !== cls.name) continue;
    // `this._repo` names a field: the parameter has the field's type, and the
    // field is injected by the parameter's key (`@Named('mem') this._repo`).
    // An initializer list `: _repo = repo` hands a parameter to a field the
    // same way.
    const fieldOf = new Map<string, string>(m.params.map((p) => [p.name, p.name]));
    for (const [, field, param] of initializerList(lines, m.line - 1)) fieldOf.set(param!, field!);
    for (const p of m.params) {
      const field = cls.properties.find((f) => f.name === fieldOf.get(p.name));
      if (!field) continue;
      if (!p.type && field.type && field.name === p.name) p.type = field.type;
      if (p.qualifier && !field.qualifier) field.qualifier = p.qualifier;
    }
  }
}

/** `UserService(UserRepo repo) : _repo = repo, _x = x;` → [_repo ← repo, _x ← x]. */
function initializerList(lines: string[], j: number): RegExpMatchArray[] {
  const text = lines.slice(j, Math.min(lines.length, j + 8)).map(codeOf).join("\n");
  const open = text.indexOf("(");
  const close = open < 0 ? -1 : closeOf(text, open);
  if (close < 0) return [];
  const after = text.slice(close).match(/^\s*:([^;{]*)/);
  if (!after) return [];
  return [...after[1]!.matchAll(/(?:^|,)\s*(?:this\s*\.\s*)?([A-Za-z_$]\w*)\s*=\s*([A-Za-z_$]\w*)\s*(?=,|$)/g)];
}

/** Annotations, then modifiers, then an optional return type and the name before `(`. */
const LEADING = String.raw`^\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*`;
const SIGNATURE_NAME_RE = new RegExp(
  LEADING +
    String.raw`(?:(?:external|static|abstract)\s+)*` +
    // A return type — never the `get`/`set` of an accessor (`set count(int v);`).
    String.raw`(?:(?!(?:get|set|operator|factory)\b)[A-Za-z_$][\w$]*(?:\s*<[^;{(]*>)?\??\s+)?` +
    String.raw`(?!(?:operator|factory|if|for|while|switch|return|await|new|const|final|var|late|super|this)\b)([A-Za-z_$]\w*)\s*(?:<[^;{(]*>)?\s*\(`,
);

function memberAt(
  lines: string[],
  j: number,
  code: string,
  cls: ClassInfo,
  spec: RegexLangSpec,
  parseParam: (t: string) => ParamInfo | null,
): FunctionInfo | null {
  const ctor = code.match(new RegExp(LEADING + String.raw`(?:const\s+)?(${cls.name})\s*\(`));
  const sig = ctor ? null : code.match(SIGNATURE_NAME_RE);
  const m = ctor ?? sig;
  if (!m) return null;
  const name = m[1]!;
  // The parameter list may wrap: read on to its `)`, then what follows it.
  const text = lines.slice(j, Math.min(lines.length, j + 12)).map(codeOf).join("\n");
  const open = m.index! + m[0].length - 1;
  const close = closeOf(text, open);
  if (close < 0) return null;
  const after = text.slice(close).trimStart();
  const hasBody = /^(?:async\*?|sync\*?)?\s*(?:\{|=>)/.test(after);
  if (sig) {
    // Only a bodiless signature: a method with a body is the function
    // pattern's, and anything else (`foo(…),`) is no declaration.
    if (!after.startsWith(";")) return null;
  } else if (!hasBody && !after.startsWith(";") && !after.startsWith(":")) return null;

  const endLine = findEndLine(lines, j, "brace");
  const line = lines[j]!;
  const inline = hasBody ? inlineBodyColumn(line, line.indexOf(name, m.index ?? 0) + name.length) : -1;
  const calls = hasBody
    ? extractCallsFromBody(lines, j + 1, endLine, spec.lineCommentPrefixes, spec.callPatterns, inline >= 0 ? { line: j, column: inline } : undefined)
    : [];
  const fn: FunctionInfo = {
    name,
    params: extractParamsFromDeclaration(lines, j, name, parseParam),
    returnType: sig ? spec.parseReturnType?.(line) ?? null : null,
    isAsync: /\basync\b/.test(after.slice(0, 8)),
    isExported: !name.startsWith("_"),
    decorators: attributeLinesAbove(lines, j, spec),
    calls,
    line: j + 1,
    endLine: sig ? j + 1 + (text.slice(0, close).match(/\n/g)?.length ?? 0) : endLine,
  };
  if (hasBody && spec.extractLocalTypes) {
    const body = lines.slice(j + 1, Math.min(endLine, lines.length));
    if (inline >= 0) body.unshift(line.slice(inline));
    const locals = spec.extractLocalTypes(body, fn);
    if (locals.length > 0) fn.localTypes = locals;
  }
  return fn;
}

/**
 * Is this class an interface the linker should route calls through? An
 * `abstract interface class` always; an `abstract` or `sealed` class when
 * every member is an abstract signature (no method body, no constructor) — a
 * pure contract its implementations fill in. A concrete `interface class`
 * can be constructed itself, so calls on it are not redirected.
 */
export function isDartInterface(header: string, cls: ClassInfo, lines: string[]): boolean {
  const mods = header.match(/^\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*((?:(?:abstract|sealed|base|interface|final|mixin)\s+)*)class\b/)?.[1] ?? "";
  if (/\bmixin\b/.test(mods)) return false;
  if (/\babstract\b/.test(mods) && /\binterface\b/.test(mods)) return true;
  if (!/\b(?:abstract|sealed)\b/.test(mods)) return false;
  if (cls.methods.length === 0) return false;
  // The function pattern only takes declarations that open a body on their
  // own line, so a member line without `{`/`=>` is an abstract signature.
  return cls.methods.every((m) => m.name !== cls.name && !/\{|=>/.test(codeOf(lines[m.line - 1] ?? "")));
}
