import type { CallInfo, ClassInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { blankStringLiterals, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";

/**
 * Fortran regex spec (FORTRAN 77 fixed form through Fortran 2018 free form;
 * the source arrives one statement per line — see source.ts).
 *
 * Program units are found by a statement-level scope scan, since `end` alone
 * may close any of them: `program` and every `subroutine` / `function`
 * (prefixes such as `pure`, `recursive`, `real(8)` included) are functions —
 * module procedures and internal procedures too, for a bare `call x` resolves
 * through the `use`d module's scope, not through a class — and derived types
 * (`type, extends(base) :: child`) are classes with their components and
 * type-bound procedures. Procedures declared inside an `interface` block are
 * declarations, not definitions.
 *
 * Calls: `name(i)` is usually an array element, so the generic `name(`
 * matcher is off. A `call` statement is a call; so is a reference `f(x)` the
 * file proves is a function — a procedure it defines or an interface
 * declares, a name it declares `external`, a non-character scalar it declares
 * (a scalar cannot be subscripted), a statement function, and — in a unit
 * with no `use`, no `include` and no host, where every array must be declared
 * in the unit — any undeclared name that is not an intrinsic.
 */

const PREFIX = String.raw`(?:pure|impure|elemental|recursive|non_recursive|module|simple)`;
const TYPESPEC = String.raw`(?:(?:integer|real|logical|complex|character|byte|double\s*precision|double\s*complex)(?:\s*\*\s*(?:\d+|\(\s*\*\s*\)))?(?:\s*\((?:[^()]|\([^()]*\))*\))?|(?:type|class)\s*\(\s*[\w*]+\s*\))`;

const PROCEDURE = new RegExp(String.raw`^\s*((?:${PREFIX}\s+)*)(?:(${TYPESPEC})\s+)?((?:${PREFIX}\s+)*)(subroutine|function)\s+([A-Za-z]\w*)\s*(\([^)]*\))?(.*)$`, "i");
const PROGRAM = /^\s*program\s+([A-Za-z]\w*)/i;
const MODULE = /^\s*module\s+(?!(?:procedure|function|subroutine|pure|impure|elemental|recursive|non_recursive)\b)([A-Za-z]\w*)\s*$/i;
const MODULE_PROCEDURE = /^\s*module\s+procedure\s+([A-Za-z]\w*)\s*$/i;
const SUBMODULE = /^\s*submodule\s*\(\s*([A-Za-z]\w*)(?:\s*:\s*\w+)?\s*\)\s*([A-Za-z]\w*)/i;
const BLOCK_DATA = /^\s*block\s*data\b(?:\s+([A-Za-z]\w*))?\s*$/i;
const TYPE_DEF = /^\s*type\s*(?:,\s*(.*?))?\s*::\s*([A-Za-z]\w*)\s*(?:\([^)]*\))?\s*$|^\s*type\s+(?!is\b)([A-Za-z]\w*)\s*$/i;
const INTERFACE = /^\s*(abstract\s+)?interface\b\s*(.*)$/i;
const END_UNIT = /^\s*end\s*(program|module|submodule|subroutine|function|type|interface|procedure|block\s*data)\b/i;
const BARE_END = /^\s*end\s*$/i;
const CONTAINS = /^\s*contains\s*$/i;
/**
 * A statement of a unit's specification part (no executable code, no calls).
 * Fortran reserves no word: `value = f(x)` assigns a variable named `value`.
 */
const DECLARATION = new RegExp(
  String.raw`^\s*(?:${TYPESPEC}|dimension|external|intrinsic|parameter|data|common|equivalence|save|implicit|use|import|namelist|format|entry|include|private|public|protected|allocatable|pointer|target|intent|optional|value|volatile|asynchronous|contiguous|bind|procedure|generic|final|sequence|enum|enumerator)(?!\w)(?!\s*(?:=(?!=)|%|\([^)]*\)\s*=(?!=)))`,
  "i",
);

/** Intrinsic procedures and statement keywords: a `name(` of these calls nothing of the project's. */
const NOT_PROCEDURES = new Set([
  // statements and keywords that take parentheses
  "if", "while", "select", "case", "where", "forall", "do", "call", "write", "read", "print", "open", "close", "inquire",
  "allocate", "deallocate", "nullify", "format", "return", "stop", "go", "goto", "to", "then", "else", "elseif",
  "elsewhere", "associate", "block", "critical", "sync", "lock", "unlock", "rewind", "backspace", "endfile", "flush",
  "wait", "entry", "data", "common", "dimension", "equivalence", "external", "intrinsic", "implicit", "parameter",
  "save", "type", "class", "is", "rank", "default", "result", "bind", "kind", "len", "character", "integer", "real",
  "logical", "complex", "double", "precision", "procedure", "error", "concurrent", "intent", "operator", "assignment",
  "extends", "only", "use", "image", "team", "event", "form", "change", "fail",
  // intrinsic functions and subroutines
  "abs", "achar", "acos", "acosh", "adjustl", "adjustr", "aimag", "aint", "all", "allocated", "anint", "any", "asin",
  "asinh", "associated", "atan", "atan2", "atanh", "bit_size", "btest", "ceiling", "char", "cmplx", "conjg", "cos",
  "cosh", "count", "cshift", "date_and_time", "dble", "dcmplx", "dconjg", "digits", "dim", "dot_product", "dprod",
  "eoshift", "epsilon", "exp", "exponent", "floor", "fraction", "huge", "iachar", "iand", "ibclr", "ibits", "ibset",
  "ichar", "ieor", "index", "int", "ior", "ishft", "ishftc", "lbound", "len_trim", "lge", "lgt", "lle", "llt", "log",
  "log10", "matmul", "max", "maxexponent", "maxloc", "maxval", "merge", "min", "minexponent", "minloc", "minval", "mod",
  "modulo", "nearest", "nint", "not", "pack", "present", "product", "radix", "random_number", "random_seed", "range",
  "repeat", "reshape", "rrspacing", "scale", "scan", "selected_int_kind", "selected_real_kind", "selected_char_kind",
  "set_exponent", "shape", "sign", "sin", "sinh", "size", "spacing", "spread", "sqrt", "sum", "system_clock", "tan",
  "tanh", "tiny", "transfer", "transpose", "trim", "ubound", "unpack", "verify", "norm2", "findloc", "popcnt", "leadz",
  "trailz", "storage_size", "new_line", "is_iostat_end", "is_iostat_eor", "move_alloc", "command_argument_count",
  "get_command", "get_command_argument", "get_environment_variable", "execute_command_line", "cpu_time", "c_loc",
  "c_funloc", "c_f_pointer", "c_f_procpointer", "c_associated", "c_sizeof", "same_type_as", "extends_type_of",
  "dabs", "dsqrt", "dexp", "dlog", "dlog10", "dsin", "dcos", "dtan", "dasin", "dacos", "datan", "datan2", "dsinh",
  "dcosh", "dtanh", "dmax1", "dmin1", "amax1", "amin1", "max0", "min0", "max1", "min1", "amax0", "amin0", "iabs",
  "isign", "dsign", "idint", "ifix", "float", "sngl", "dfloat", "dint", "dnint", "idnint", "alog", "alog10", "cabs",
  "csqrt", "cexp", "clog", "csin", "ccos", "dmod", "amod", "dimag", "dreal", "zabs", "lshift", "rshift", "and", "or",
  "xor", "loc", "sizeof", "etime", "dtime", "getarg", "iargc", "flush", "system", "rand", "srand", "irand",
]);

interface Frame {
  kind: "program" | "module" | "submodule" | "subroutine" | "function" | "procedure" | "type" | "interface" | "blockdata";
  name: string;
  /** 0-based line of the opening statement. */
  start: number;
  end: number;
  parent: Frame | null;
  children: Frame[];
  /** 0-based line of the unit's `contains`, if any. */
  containsAt?: number;
  /** Function result type written in front (`real(8) function f`). */
  typeSpec?: string;
  recursive?: boolean;
  args?: string;
  /** The opening statement's tail: `result(r)`, `bind(c)`, a type's attributes. */
  tail?: string;
  /** Declared inside an `interface` block: a signature, not a definition. */
  declarationOnly: boolean;
}

/** Strip a statement label (`100 continue`) — fixed form had it in columns 1–5. */
const unlabeled = (line: string): string => line.replace(/^\s*\d+\s+/, "");

/** Every program unit, derived type and interface block of the file, nested. */
function scanUnits(lines: string[]): Frame[] {
  const roots: Frame[] = [];
  const stack: Frame[] = [];
  const open = (frame: Omit<Frame, "parent" | "children" | "end">): void => {
    const parent = stack[stack.length - 1] ?? null;
    const f: Frame = { ...frame, parent, children: [], end: lines.length - 1 };
    (parent ? parent.children : roots).push(f);
    stack.push(f);
  };
  const close = (i: number, kind?: string): void => {
    // `end <kind>` closes the innermost frame of that kind (and any left open inside it).
    let k = stack.length - 1;
    if (kind) while (k >= 0 && stack[k]!.kind !== kind) k--;
    else while (k >= 0 && (stack[k]!.kind === "type" || stack[k]!.kind === "interface")) k--;
    if (k < 0) return;
    for (let j = stack.length - 1; j >= k; j--) stack[j]!.end = i;
    stack.length = k;
  };
  for (let i = 0; i < lines.length; i++) {
    const text = unlabeled(lines[i]!);
    if (text.trim() === "") continue;
    const top = stack[stack.length - 1];
    const inInterface = top?.kind === "interface" || stack.some((f) => f.kind === "interface");
    const end = END_UNIT.exec(text);
    if (end) {
      const kind = end[1]!.toLowerCase().replace(/\s+/g, "");
      close(i, kind === "blockdata" ? "blockdata" : kind);
      continue;
    }
    if (BARE_END.test(text)) {
      close(i);
      continue;
    }
    if (CONTAINS.test(text)) {
      if (top) top.containsAt = i;
      continue;
    }
    if (top?.kind === "type") continue; // components and bindings: read per type
    const iface = INTERFACE.exec(text);
    if (iface) {
      open({ kind: "interface", name: /^[A-Za-z]\w*$/.exec(iface[2]!.trim())?.[0] ?? "", start: i, declarationOnly: true });
      continue;
    }
    const proc = PROCEDURE.exec(text);
    if (proc) {
      const prefixes = `${proc[1] ?? ""} ${proc[3] ?? ""}`;
      open({
        kind: proc[4]!.toLowerCase() as "subroutine" | "function",
        name: proc[5]!,
        start: i,
        ...(proc[2] ? { typeSpec: proc[2].replace(/\s+/g, " ") } : {}),
        recursive: /\brecursive\b/i.test(prefixes),
        args: (proc[6] ?? "()").slice(1, -1),
        tail: proc[7] ?? "",
        declarationOnly: inInterface,
      });
      continue;
    }
    if (inInterface) continue; // `module procedure a, b` lists, nothing opens
    const prog = PROGRAM.exec(text);
    if (prog) { open({ kind: "program", name: prog[1]!, start: i, declarationOnly: false }); continue; }
    const mp = MODULE_PROCEDURE.exec(text);
    if (mp) { open({ kind: "procedure", name: mp[1]!, start: i, args: "", declarationOnly: false }); continue; }
    const mod = MODULE.exec(text);
    if (mod) { open({ kind: "module", name: mod[1]!, start: i, declarationOnly: false }); continue; }
    const sub = SUBMODULE.exec(text);
    if (sub) { open({ kind: "submodule", name: sub[2]!, start: i, tail: sub[1]!, declarationOnly: false }); continue; }
    const bd = BLOCK_DATA.exec(text);
    if (bd) { open({ kind: "blockdata", name: bd[1] ?? "", start: i, declarationOnly: false }); continue; }
    const type = TYPE_DEF.exec(text);
    if (type) open({ kind: "type", name: (type[2] ?? type[3])!, start: i, tail: type[1] ?? "", declarationOnly: inInterface });
  }
  return roots;
}

function walk(frames: Frame[], visit: (f: Frame) => void): void {
  for (const f of frames) {
    visit(f);
    walk(f.children, visit);
  }
}

/** What a unit's own declarations say about its names (lowercase). */
interface Declarations {
  types: Map<string, string>;
  arrays: Set<string>;
  characters: Set<string>;
  parameters: Set<string>;
  externals: Set<string>;
  intrinsics: Set<string>;
  /** Every name declared in any way (types, `common`, `dimension`, …). */
  declared: Set<string>;
  statementFunctions: Set<string>;
  usesModules: boolean;
  includes: boolean;
}

/** The 0-based lines that are the unit's OWN statements: not a child unit's, type's or interface's. */
function ownLines(f: Frame): number[] {
  const out: number[] = [];
  const last = f.containsAt !== undefined ? f.containsAt - 1 : f.end - 1;
  for (let i = f.start + 1; i <= last; i++) {
    if (f.children.some((c) => i >= c.start && i <= c.end)) continue;
    out.push(i);
  }
  return out;
}

/** `real(8), intent(in) :: a(n), b` / `integer i, j(10)` → the entities with what they are. */
function declare(text: string, d: Declarations): void {
  const lower = text.toLowerCase();
  if (/^\s*use\b/.test(lower)) { d.usesModules = true; return; }
  if (/^\s*include\b/.test(lower)) { d.includes = true; return; }
  const list = (s: string) => splitTopLevel(s).map((e) => e.trim()).filter(Boolean);
  const nameOf = (e: string) => /^([a-z]\w*)/i.exec(e)?.[1]?.toLowerCase();
  let m = /^\s*(external|intrinsic)\s*(?:::)?\s*(.*)$/i.exec(text);
  if (m) {
    for (const e of list(m[2]!)) {
      const n = nameOf(e);
      if (n) (m[1]!.toLowerCase() === "external" ? d.externals : d.intrinsics).add(n);
    }
    return;
  }
  m = /^\s*dimension\s*(?:::)?\s*(.*)$/i.exec(text);
  if (m) {
    for (const e of list(m[1]!)) { const n = nameOf(e); if (n) { d.arrays.add(n); d.declared.add(n); } }
    return;
  }
  m = /^\s*common\s*(?:\/\s*\w*\s*\/)?(.*)$/i.exec(text);
  if (m) {
    for (const e of list(m[1]!.replace(/\/\s*\w*\s*\//g, ","))) {
      const n = nameOf(e);
      if (!n) continue;
      d.declared.add(n);
      if (/^\w+\s*\(/.test(e)) d.arrays.add(n);
    }
    return;
  }
  m = /^\s*parameter\s*\((.*)\)\s*$/i.exec(text);
  if (m) {
    for (const e of list(m[1]!)) { const n = nameOf(e); if (n) { d.parameters.add(n); d.declared.add(n); } }
    return;
  }
  m = new RegExp(String.raw`^\s*(${TYPESPEC})\s*(?:,\s*(.*?))?\s*::\s*(.*)$`, "i").exec(text) ??
    new RegExp(String.raw`^\s*(${TYPESPEC})\s+(?!function\b|subroutine\b)()([a-z]\w*.*)$`, "i").exec(text);
  if (!m) return;
  const type = m[1]!.replace(/\s+/g, " ");
  const attrs = (m[2] ?? "").toLowerCase();
  const isChar = /^character/i.test(type);
  for (const e of list(m[3]!)) {
    const n = nameOf(e);
    if (!n) continue;
    d.declared.add(n);
    d.types.set(n, type);
    if (isChar) d.characters.add(n);
    if (/\bdimension\b/.test(attrs) || /^[a-z]\w*\s*\(/i.test(e)) d.arrays.add(n);
    if (/\bparameter\b/.test(attrs)) d.parameters.add(n);
    if (/\bexternal\b/.test(attrs)) d.externals.add(n);
  }
}

function declarationsOf(lines: string[], f: Frame): Declarations {
  const d: Declarations = {
    types: new Map(), arrays: new Set(), characters: new Set(), parameters: new Set(), externals: new Set(),
    intrinsics: new Set(), declared: new Set(), statementFunctions: new Set(), usesModules: false, includes: false,
  };
  for (const i of ownLines(f)) {
    const text = unlabeled(lines[i]!);
    if (DECLARATION.test(text)) declare(text, d);
  }
  // A statement function: `area(r) = pi * r**2`. Only where every array is
  // declared in the unit itself — elsewhere `a(i) = 0` may set an element of
  // an array a module, an include or the host declares.
  if (f.parent === null && !d.usesModules && !d.includes) {
    for (const i of ownLines(f)) {
      const sf = /^\s*([a-z]\w*)\s*\(([^()]*)\)\s*=(?!=)/i.exec(unlabeled(lines[i]!));
      if (sf && !d.arrays.has(sf[1]!.toLowerCase()) && /^[\s\w,]*$/.test(sf[2]!)) d.statementFunctions.add(sf[1]!.toLowerCase());
    }
  }
  return d;
}

/**
 * The calls one unit makes in its own executable statements: `call x(…)` /
 * `call obj%method(…)` (recorded `obj.method`), and the function references
 * `provable` says are calls.
 */
function unitCalls(lines: string[], f: Frame, provable: (name: string) => boolean): CallInfo[] {
  const calls: CallInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, line: number, column: number) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ name, kind: "internal", target: null, line: line + 1, column });
  };
  for (const i of ownLines(f)) {
    const text = blankStringLiterals(unlabeled(lines[i]!));
    if (DECLARATION.test(text)) continue;
    for (const m of text.matchAll(/(?:^\s*|\)\s*|\bthen\s+|\belse\s+)call\s+([A-Za-z]\w*(?:\s*%\s*[A-Za-z]\w*)*)/gi)) {
      add(m[1]!.replace(/\s*%\s*/g, "."), i, m.index! + m[0].length - m[1]!.length);
    }
    // An assignment's target is no reference: `f(i) = …` sets an element (or defines a statement function).
    const lhs = /^\s*[A-Za-z]\w*\s*\([^=]*?\)\s*=(?!=)/.exec(text)?.[0].length ?? 0;
    // Not a component (`a%b(i)`), not a dotted operator (`.not.(x)`).
    for (const m of text.matchAll(/(?<![%\w.])([A-Za-z]\w*)\s*\(/g)) {
      if (m.index! < lhs) continue;
      if (/\bcall\s+$/i.test(text.slice(0, m.index!))) continue;
      const name = m[1]!;
      const key = name.toLowerCase();
      if (key === f.name.toLowerCase() && !f.recursive) continue;
      if (provable(key)) add(name, i, m.index!);
    }
  }
  return calls;
}

/** `(a, b, n)` with what the unit declares of each. */
function unitParams(f: Frame, d: Declarations): ParamInfo[] {
  return splitTopLevel(f.args ?? "")
    .map((a) => a.trim())
    .filter((a) => /^[A-Za-z]\w*$/.test(a) || a === "*")
    .map((name) => ({ name, type: d.types.get(name.toLowerCase()) ?? null, defaultValue: null }));
}

/** Module visibility: `private` / `public` statements of the module's specification part. */
function visibility(lines: string[], mod: Frame): (name: string) => boolean {
  let defaultPublic = true;
  const explicit = new Map<string, boolean>();
  for (const i of ownLines(mod)) {
    const m = /^\s*(private|public)\b\s*(?:::)?\s*(.*)$/i.exec(unlabeled(lines[i]!));
    if (!m) continue;
    const pub = m[1]!.toLowerCase() === "public";
    if (m[2]!.trim() === "") defaultPublic = pub;
    else for (const n of m[2]!.split(",")) {
      const name = /^\s*([A-Za-z]\w*)/.exec(n)?.[1];
      if (name) explicit.set(name.toLowerCase(), pub);
    }
  }
  return (name) => explicit.get(name.toLowerCase()) ?? defaultPublic;
}

interface FortranUnits {
  functions: FunctionInfo[];
  classes: ClassInfo[];
}

/** Functions and derived types of the (normalized) file, computed once per line array. */
const CACHE = new WeakMap<string[], FortranUnits>();
export function fortranUnits(lines: string[]): FortranUnits {
  const hit = CACHE.get(lines);
  if (hit) return hit;
  const roots = scanUnits(lines);
  const all: Frame[] = [];
  walk(roots, (f) => all.push(f));

  // Names the file proves are procedures: what it defines, what interfaces
  // declare (and generic interface names), what any unit declares `external`.
  const defined = new Set<string>();
  for (const f of all) {
    if (f.kind === "subroutine" || f.kind === "function" || f.kind === "procedure") defined.add(f.name.toLowerCase());
    if (f.kind === "interface" && f.name) defined.add(f.name.toLowerCase());
  }
  const decls = new Map<Frame, Declarations>();
  for (const f of all) if (f.kind !== "interface" && f.kind !== "type") decls.set(f, declarationsOf(lines, f));

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  for (const f of all) {
    if (f.declarationOnly) continue;
    if (f.kind === "type") {
      classes.push(derivedType(lines, f));
      continue;
    }
    if (f.kind !== "program" && f.kind !== "subroutine" && f.kind !== "function" && f.kind !== "procedure") continue;
    const d = decls.get(f)!;
    // The scopes whose declarations this unit sees: itself and its hosts.
    const scopes: Declarations[] = [];
    for (let s: Frame | null = f; s; s = s.parent) if (decls.has(s)) scopes.push(decls.get(s)!);
    const hosted = f.parent !== null;
    const selfContained = !hosted && !d.usesModules && !d.includes;
    const provable = (name: string): boolean => {
      if (scopes.some((s) => s.arrays.has(name) || s.characters.has(name) || s.parameters.has(name) || s.intrinsics.has(name))) return false;
      if (defined.has(name) || d.statementFunctions.has(name)) return true;
      if (scopes.some((s) => s.externals.has(name))) return true;
      // An intrinsic may be given a type (`DOUBLE PRECISION DEXP`): it stays the intrinsic.
      if (NOT_PROCEDURES.has(name)) return false;
      if (scopes.some((s) => s.types.has(name))) return true; // a declared scalar cannot be subscripted
      return selfContained && !scopes.some((s) => s.declared.has(name));
    };
    const host = f.parent;
    const exported =
      f.kind === "program" ? false
        : !host ? true
          : host.kind === "module" ? visibility(lines, host)(f.name)
            : host.kind === "submodule";
    const fn: FunctionInfo = {
      name: f.name,
      params: unitParams(f, d),
      returnType: f.kind === "function" ? f.typeSpec ?? resultType(f, d) : null,
      isAsync: false,
      isExported: exported,
      decorators: decoratorsOf(lines[f.start]!),
      calls: unitCalls(lines, f, provable),
      line: f.start + 1,
      endLine: f.end + 1,
    };
    const locals = [...d.types].filter(([, t]) => /^(?:type|class)\s*\(\s*\w+\s*\)$/i.test(t))
      .map(([name, t]) => ({ name, type: /\(\s*(\w+)\s*\)/.exec(t)![1]! }));
    if (locals.length > 0) fn.localTypes = locals;
    functions.push(fn);
  }
  const result = { functions, classes };
  CACHE.set(lines, result);
  return result;
}

/** The result variable's declared type: `function f(x) result(r)` + `real :: r`, or the function's own name. */
function resultType(f: Frame, d: Declarations): string | null {
  const result = /\bresult\s*\(\s*(\w+)\s*\)/i.exec(f.tail ?? "")?.[1] ?? f.name;
  return d.types.get(result.toLowerCase()) ?? null;
}

/** `pure`, `elemental`, `recursive`, `bind(c, name="x")` — what the opening statement says of the procedure. */
function decoratorsOf(line: string): string[] {
  const head = line.slice(0, Math.max(0, line.search(/\b(?:subroutine|function|procedure)\b/i)));
  const out = [...head.matchAll(/\b(pure|impure|elemental|recursive|non_recursive|module)\b/gi)].map((m) => m[1]!.toLowerCase());
  const bind = /\bbind\s*\(([^)]*)\)/i.exec(line);
  if (bind) out.push(`bind(${bind[1]!.replace(/\s+/g, " ").trim()})`);
  return out;
}

/** A derived type: its parent (`extends(base)`), components, and type-bound procedures as methods. */
function derivedType(lines: string[], f: Frame): ClassInfo {
  const attrs = f.tail ?? "";
  const cls: ClassInfo = {
    name: f.name,
    extends: /\bextends\s*\(\s*(\w+)\s*\)/i.exec(attrs)?.[1] ?? null,
    implements: [],
    decorators: splitTopLevel(attrs).map((a) => a.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean),
    methods: [],
    properties: [],
    isExported: !/\bprivate\b/i.test(attrs),
    line: f.start + 1,
    endLine: f.end + 1,
  };
  let defaultPrivate = false;
  for (let i = f.start + 1; i < f.end; i++) {
    const text = unlabeled(lines[i]!);
    if (/^\s*private\s*$/i.test(text)) { defaultPrivate = true; continue; }
    if (f.containsAt !== undefined && i > f.containsAt) {
      // `procedure :: area => circle_area, perimeter` binds each name; `generic
      // :: get => get_int, get_real` binds ONE name to the procedures after `=>`.
      const b = /^\s*(procedure|generic)\b(?:\s*\([^)]*\))?\s*(?:,\s*[^:]*)?::\s*(.*)$/i.exec(text);
      if (!b) continue;
      const entries = b[1]!.toLowerCase() === "generic" ? [b[2]!.replace(/=>.*$/s, "")] : splitTopLevel(b[2]!);
      for (const part of entries) {
        const name = /^\s*([A-Za-z]\w*)/.exec(part)?.[1];
        if (!name || /^(?:operator|assignment)$/i.test(name)) continue;
        cls.methods.push({ name, params: [], returnType: null, isAsync: false, isExported: !/\bprivate\b/i.test(text), decorators: [], calls: [], line: i + 1, endLine: i + 1 });
      }
      continue;
    }
    const m = new RegExp(String.raw`^\s*(${TYPESPEC})\s*(?:,\s*(.*?))?\s*::\s*(.*)$`, "i").exec(text) ??
      new RegExp(String.raw`^\s*(${TYPESPEC})\s+()([a-z]\w*.*)$`, "i").exec(text);
    if (!m) continue;
    const componentAttrs = (m[2] ?? "").toLowerCase();
    for (const e of splitTopLevel(m[3]!)) {
      const name = /^\s*([A-Za-z]\w*)/.exec(e)?.[1];
      if (!name) continue;
      const priv = /\bprivate\b/.test(componentAttrs) || (defaultPrivate && !/\bpublic\b/.test(componentAttrs));
      const prop: PropertyInfo = {
        name,
        type: m[1]!.replace(/\s+/g, " ") + (/\bdimension\s*\(([^)]*)\)/.exec(componentAttrs) ? "(:)" : /^\s*\w+\s*\(/.test(e) ? "(:)" : ""),
        visibility: priv ? "private" : "public",
        isStatic: false,
        isReadonly: /\bparameter\b/.test(componentAttrs),
      };
      cls.properties.push(prop);
    }
  }
  return cls;
}

/**
 * Imports: `use mod`, `use, intrinsic :: iso_c_binding`, `use mod, only: a, b
 * => c` (the names it binds are its specifiers), `include 'x.inc'`. A
 * preprocessor `#include "x.h"` is read from the raw source.
 */
export function fortranImports(lines: string[], rawLines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    const text = unlabeled(line);
    const use = /^\s*use\b(?:\s*,\s*(?:non_)?intrinsic)?\s*(?:::)?\s*([A-Za-z]\w*)\s*(?:,\s*only\s*:\s*(.*))?/i.exec(text);
    if (use) {
      const specifiers = splitTopLevel(use[2] ?? "")
        .map((s) => /^\s*([A-Za-z]\w*)/.exec(s)?.[1])
        .filter((s): s is string => !!s && !/^(?:operator|assignment)$/i.test(s));
      out.push({ source: use[1]!, specifiers, isDefault: false, isNamespace: specifiers.length === 0, isType: false, line: i + 1 });
      return;
    }
    const inc = /^\s*include\s+(['"])([^'"]+)\1/i.exec(text);
    if (inc) out.push({ source: inc[2]!, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: i + 1 });
  });
  rawLines.forEach((line, i) => {
    const cpp = /^\s*#\s*include\s+["<]([^">]+)[">]/.exec(line);
    if (cpp) out.push({ source: cpp[1]!, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: i + 1 });
  });
  return out.sort((a, b) => a.line - b.line);
}

export const fortranSpec: RegexLangSpec = {
  language: "fortran",
  extensions: [".f", ".for", ".f77", ".f90", ".f95", ".f03", ".f08", ".fpp"],
  lineCommentPrefixes: ["!"],
  // Units are found by `fortranUnits`' scope scan (a bare `end` may close any
  // of them), so no line pattern opens one here.
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  extractClasses: (lines) => fortranUnits(lines).classes,
  postProcessFunctions: (lines) => fortranUnits(lines).functions,
};
