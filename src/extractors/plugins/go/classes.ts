import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractParamsFromDeclaration, findEndLine, inlineBodyColumn, type ParamParser } from "../shared/regex-base.js";
import { extractGoLocalTypes, type GoConstructors } from "./locals.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";
import { bracketDelta, goResultTextAt, goResultTypes, splitGoTopLevel, stripGoComment } from "./syntax.js";

/**
 * Go types as the linker needs them. Go declares methods OUTSIDE the type, in
 * any file of the package, so the generic class pass sees structs without
 * methods and methods as free functions — two types' `Load` collided in one
 * file, and `s.repo.Find()` had no class to start from. Here:
 *
 * - every method (`func (s *Svc) Run(…)`, pointer or value receiver) belongs
 *   to its receiver type: the struct's own ClassInfo when the file declares
 *   it, else a stub ClassInfo for the type carrying only this file's methods
 *   (core reads a type's stubs across one directory as one type);
 * - the receiver variable is a typed local of its method (`s` → `Svc`), so
 *   `s.validate()` reaches the type's own method;
 * - interfaces are `kind: "interface"`, `structural: true` (a Go type never
 *   names the interfaces it satisfies) with their method specs as methods —
 *   except one that embeds another interface or a type set: its method set is
 *   not all written here, and matching a partial set would accept types that
 *   do not satisfy it;
 * - struct fields cover embedded fields (`UserRepo`, `*Base`, named after the
 *   type, marked `embedded`), grouped names (`a, b *T`), one-line struct
 *   bodies and trailing comments;
 * - grouped parameters (`func f(a, b *Repo)`) give every name the type;
 * - locals initialised from a constructor declared in this file
 *   (`r := NewPgRepo()`) take its result type (see locals.ts).
 */
export function extractGoClasses(lines: string[], fns: FunctionInfo[], parseParam: ParamParser): ClassInfo[] {
  const classes = scanTypeDeclarations(lines, parseParam);
  const constructors = sameFileConstructors(lines, fns);

  const structs = new Map<string, ClassInfo>();
  for (const cls of classes) if (cls.kind !== "interface" && !structs.has(cls.name)) structs.set(cls.name, cls);
  const stubs = new Map<string, ClassInfo>();

  for (const fn of fns) {
    const decl = lines[fn.line - 1] ?? "";
    regroupParams(fn, lines, parseParam);
    const recv = RECEIVER_RE.exec(decl);
    const receiver = recv && recv[3] === fn.name ? { name: recv[1], type: recv[2]! } : null;

    const inline = inlineBodyColumn(decl, decl.indexOf(fn.name) + fn.name.length);
    const body = lines.slice(fn.line, fn.endLine);
    if (inline >= 0) body.unshift(decl.slice(inline));
    const declared = new Set<string>();
    const locals = extractGoLocalTypes(body, fn.params, constructors, declared);
    if (receiver?.name && receiver.name !== "_") {
      // A local of the receiver's name shadows it somewhere in the body:
      // which one a call sees cannot be told, so neither is kept.
      const shadow = locals.findIndex((l) => l.name === receiver.name);
      if (shadow >= 0) locals.splice(shadow, 1);
      else if (!declared.has(receiver.name)) locals.unshift({ name: receiver.name, type: receiver.type });
    }
    if (locals.length > 0) fn.localTypes = locals;
    else delete fn.localTypes;

    if (!receiver) continue;
    const owner = structs.get(receiver.type) ?? stubs.get(receiver.type) ?? newStub(receiver.type, fn, stubs);
    owner.methods.push(fn);
    if (stubs.get(receiver.type) === owner) owner.endLine = Math.max(owner.endLine, fn.endLine);
  }
  return [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
}

/** `func (s *Svc) Run(` / `func (Svc) Name(` / `func (s *Stack[T]) Push(` → receiver var, type, method. */
const RECEIVER_RE = /^func\s*\(\s*(?:([A-Za-z_]\w*)\s+)?\*?\s*([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/;

function newStub(name: string, first: FunctionInfo, stubs: Map<string, ClassInfo>): ClassInfo {
  const stub: ClassInfo = {
    name,
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties: [],
    isExported: /^[A-Z]/.test(name),
    line: first.line,
    endLine: first.endLine,
  };
  stubs.set(name, stub);
  return stub;
}

/** `type X struct {` / `type X[T any] interface {`, or the same inside a `type ( … )` group. */
const TYPE_DECL_RE = /^(?:type\s+|\s+)([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\s*\{/;

/** Struct and interface declarations, top-level and in `type ( … )` groups. */
function scanTypeDeclarations(lines: string[], parseParam: ParamParser): ClassInfo[] {
  const out: ClassInfo[] = [];
  let inGroup = false;
  for (let i = 0; i < lines.length; i++) {
    const line = stripGoComment(lines[i]!);
    if (/^type\s*\(\s*$/.test(line)) { inGroup = true; continue; }
    if (inGroup && /^\)/.test(line)) { inGroup = false; continue; }
    // Outside a group only column-0 `type` declarations count: a function's
    // local types and a struct's inline-struct fields are not package types.
    if (!inGroup && !line.startsWith("type")) continue;
    const m = TYPE_DECL_RE.exec(line);
    if (!m) continue;
    const endLine = findEndLine(lines, i, "brace");
    const open = line.indexOf("{", m.index + m[0].length - 1);
    const cls: ClassInfo = {
      name: m[1]!,
      extends: null,
      implements: [],
      decorators: [],
      methods: [],
      properties: [],
      isExported: /^[A-Z]/.test(m[1]!),
      line: i + 1,
      endLine,
    };
    const segments = bodySegments(lines, i, open, endLine);
    if (m[2] === "struct") {
      for (const seg of segments) cls.properties.push(...parseGoFields(seg.text));
    } else {
      cls.kind = "interface";
      let complete = true;
      for (const seg of segments) {
        const spec = /^([A-Za-z_]\w*)\s*\(/.exec(seg.text);
        if (spec) cls.methods.push(methodSpec(spec[1]!, seg, parseParam));
        else complete = false; // embedded interface or type-set term
      }
      if (complete) cls.structural = true;
    }
    out.push(cls);
    i = Math.max(i, endLine - 1);
  }
  return out;
}

interface Segment { text: string; line: number; endLine: number }

/**
 * The members of a struct/interface body at its own depth, one per field or
 * method spec, comments stripped. A one-line body (`struct{ a int; b string }`)
 * splits on `;`; a member wrapped over several lines is joined.
 */
function bodySegments(lines: string[], declIdx: number, open: number, endLine: number): Segment[] {
  const decl = stripGoComment(lines[declIdx]!);
  const out: Segment[] = [];
  const push = (text: string, line: number, end: number) => {
    for (const part of text.split(";")) {
      const t = part.trim();
      if (t) out.push({ text: t, line, endLine: end });
    }
  };
  if (endLine === declIdx + 1) {
    const close = decl.lastIndexOf("}");
    if (open >= 0 && close > open) push(decl.slice(open + 1, close), declIdx + 1, declIdx + 1);
    return out;
  }
  if (open >= 0) push(decl.slice(open + 1), declIdx + 1, declIdx + 1);
  let pending: Segment | null = null;
  let depth = 0;
  for (let i = declIdx + 1; i < Math.min(endLine - 1, lines.length); i++) {
    const text = stripGoComment(lines[i]!);
    const delta = bracketDelta(text);
    if (pending) {
      pending.text += " " + text.trim();
      pending.endLine = i + 1;
      depth += delta;
      if (depth <= 0) { push(pending.text, pending.line, pending.endLine); pending = null; depth = 0; }
      continue;
    }
    if (delta > 0) {
      pending = { text: text.trim(), line: i + 1, endLine: i + 1 };
      depth = delta;
      continue;
    }
    push(text, i + 1, i + 1);
  }
  // The closing line may carry a last member (`  Name string }`).
  const last = stripGoComment(lines[endLine - 1] ?? "");
  const closeAt = last.lastIndexOf("}");
  if (endLine - 1 > declIdx && closeAt > 0) push(last.slice(0, closeAt), endLine, endLine);
  return out;
}

function methodSpec(name: string, seg: Segment, parseParam: ParamParser): FunctionInfo {
  const open = seg.text.indexOf("(");
  const close = matchingParen(seg.text, open);
  const params = close > open ? groupedParams(splitGoTopLevel(seg.text.slice(open + 1, close)), parseParam) : [];
  const results = close > open ? goResultTypes(seg.text.slice(close + 1)) : [];
  const ret = results.find((r) => r !== "error") ?? results[0] ?? null;
  return {
    name,
    params,
    returnType: ret ? stripTypeModifiers(ret, "go") : null,
    isAsync: false,
    isExported: /^[A-Z]/.test(name),
    decorators: [],
    calls: [],
    line: seg.line,
    endLine: seg.endLine,
  };
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * One struct member → its fields:
 *   `Name string \`json:"name"\``  → Name (tags as decorators)
 *   `a, b *PgRepo`                 → a, b
 *   `UserRepo` / `*Base` / `pkg.T` → UserRepo / Base / T, type as written, `embedded`
 * Func-typed and inline-struct fields are skipped (`interface{}`/`struct{}` kept).
 */
export function parseGoFields(member: string): PropertyInfo[] {
  let text = member.trim();
  if (!text) return [];
  let tags: string[] = [];
  const tag = /`([^`]*)`\s*$/.exec(text);
  if (tag) {
    tags = [...tag[1]!.matchAll(/(\w+):"((?:[^"\\]|\\.)*)"/g)].map((t) => `${t[1]}:"${t[2]}"`);
    text = text.slice(0, tag.index).trim();
  }
  const field = (name: string, type: string, embedded = false): PropertyInfo => {
    const prop: PropertyInfo = {
      name,
      type,
      visibility: /^[A-Z]/.test(name) ? "public" : "private",
      isStatic: false,
      isReadonly: false,
    };
    const decorators = embedded ? [...tags, "embedded"] : tags;
    if (decorators.length > 0) prop.decorators = decorators;
    return prop;
  };

  const embedded = /^\*?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)(?:\[[^\]]*\])?$/.exec(text);
  if (embedded) return [field(embedded[1]!.split(".").pop()!, text, true)];

  const named = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+(\S.*)$/.exec(text);
  if (!named) return [];
  const type = named[2]!.trim().replace(/\s+/g, " ");
  // Skip func-shaped and inline-struct fields, but keep `interface{}` / `struct{}`.
  if (/[{(]/.test(type.replace(/interface\s?\{\}|struct\s?\{\}/g, ""))) return [];
  return named[1]!.split(",").map((n) => n.trim()).filter((n) => n && n !== "_").map((n) => field(n, type));
}

/**
 * Re-read a function's parameter list with Go's grouping rule: in
 * `(a, b *Repo, id int)` the bare `a` shares the type written after it. The
 * per-parameter parser cannot see that, and took `a` for an anonymous
 * parameter of type `a`.
 */
function regroupParams(fn: FunctionInfo, lines: string[], parseParam: ParamParser): void {
  if (!fn.params.some((p) => p.name === "_")) return;
  const raw = extractParamsFromDeclaration(lines, fn.line - 1, fn.name, (t) => ({ name: t.trim(), type: null, defaultValue: null }));
  if (raw.length !== fn.params.length) return;
  fn.params = groupedParams(raw.map((p) => p.name), parseParam);
}

function groupedParams(raw: string[], parseParam: ParamParser): ParamInfo[] {
  const parsed = raw.map((r) => parseParam(r)).filter((p): p is ParamInfo => p !== null);
  if (parsed.length !== raw.length) return parsed;
  const named = raw.some((r) => /^[A-Za-z_]\w*\s+\S/.test(r.trim()));
  if (!named) return parsed;
  let pendingType: string | null = null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const token = raw[i]!.trim();
    if (/^[A-Za-z_]\w*$/.test(token)) {
      parsed[i] = { name: token, type: pendingType, defaultValue: null };
    } else {
      pendingType = parsed[i]!.type;
    }
  }
  return parsed;
}

/**
 * Functions (not methods) declared in this file with their result types —
 * what `r := NewPgRepo()` initialises a local with.
 */
function sameFileConstructors(lines: string[], fns: FunctionInfo[]): GoConstructors {
  const out = new Map<string, string[]>();
  for (const fn of fns) {
    const decl = stripGoComment(lines[fn.line - 1] ?? "");
    const head = new RegExp(`^func\\s+${fn.name}\\s*(?:\\[[^\\]]*\\]\\s*)?\\(`).exec(decl);
    if (!head) continue;
    const results = goResultTextAt(decl, head[0].length - 1);
    const types = results ? goResultTypes(results.text) : [];
    if (types.length > 0) out.set(fn.name, types);
  }
  return out;
}
