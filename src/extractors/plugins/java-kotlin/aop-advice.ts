import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { isTestFile } from "../../../core/test-file-detector.js";
import { matchingParen } from "../shared/text-scan.js";
import { splitTopLevel } from "../../shared/split-top-level.js";

/**
 * Spring AOP / AspectJ advice on its join points. An `@Aspect` class's `@Before`, `@After`, `@AfterReturning`,
 * `@AfterThrowing` and `@Around` methods run around every project method their pointcut matches, yet no call
 * names them. Each match is an INFERRED edge from the join-point method to the advice, so a route's reach lists
 * the auth, audit and transaction advice between it and its data.
 *
 * The pointcut is read as text from the annotation (no new per-file fact): `execution(...)`, `within(...)`,
 * `@annotation(...)`, `@within(...)`, `&&`, `||`, `!`, parentheses and a `@Pointcut` method named by `name()`
 * (the aspect's own, else a unique one of another aspect). Evaluation is three-valued: a designator this does
 * not read (`args`, `this`, `target`, `bean`, `cflow`, a name no aspect declares, a modifier other than
 * `public`) is unknown, and an edge is drawn only when the whole expression is certainly true — never because
 * an unknown part was ignored. `..` in a type or package pattern is zero or more whole segments, matched by a
 * dynamic program over the segments (no backtracking, so a long pattern cannot blow up). Also read: `within(@pkg.Anno *)`,
 * an `@annotation` literal type or an advice parameter bound by name. An interface named by `execution` also reaches
 * the project classes implementing it; test files and the aspects themselves are no join points. A pointcut's type
 * name resolves through the aspect file's imports (`resolveSimpleName`: the alias a Kotlin `import … as` binds, never a
 * static import's member), else its own package; each `execution(...)` atom is compiled once per run and fails on its
 * name glob first. The advice text may be a string, `"a" + "b"`, a Java text block, `value=` or `pointcut=`.
 */
export class AopAdviceResolver implements DispatchResolver {
  readonly id = "aop-advice";
  readonly languages: Language[] = ["java", "kotlin"];
  readonly priority = 13;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const aspects = collectAspects(analyses);
    if (aspects.length === 0) return [];
    const index = new ProjectIndex(analyses);
    const aspectKeys = new Set(aspects.map((a) => `${a.file.filePath}::${a.cls.name}`));
    const joinPoints = index.joinPoints.filter((jp) => !aspectKeys.has(`${jp.file.filePath}::${jp.cls.name}`));
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const aspect of aspects) {
      for (const advice of aspect.advice) {
        const expr = parsePointcut(advice.expression);
        if (!expr) continue;
        const bindings = new Map<string, string>();
        for (const p of advice.method.params) if (p.type) bindings.set(p.name, p.type);
        for (const jp of joinPoints) {
          const ctx: EvalContext = { index, aspects, aspect, advice: bindings, jp, depth: 0 };
          if (evalNode(expr, ctx) !== true) continue;
          const sourceSymbol = `${jp.cls.name}.${jp.method.name}`;
          const key = `${jp.file.filePath}|${sourceSymbol}|${aspect.file.filePath}|${aspect.cls.name}.${advice.method.name}@${advice.method.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({
            sourceFile: jp.file.filePath,
            sourceSymbol,
            sourceLine: jp.method.line,
            callName: `@${advice.kind} ${advice.method.name}`,
            targetFile: aspect.file.filePath,
            targetSymbol: `${aspect.cls.name}.${advice.method.name}`,
            targetLine: advice.method.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}

// ── Aspects ────────────────────────────────────────────────────────────────────────────────────

interface Advice {
  kind: string;
  method: FunctionInfo;
  expression: string;
}
interface Aspect {
  file: FileAnalysis;
  cls: ClassInfo;
  advice: Advice[];
  pointcuts: Map<string, string>;
}

const ADVICE_KINDS = new Set(["Before", "After", "AfterReturning", "AfterThrowing", "Around"]);

/** `Before("x")` / `org.aspectj.lang.annotation.Before(value = "x")` → name and the raw argument text. */
function parseDecorator(text: string): { name: string; args: string | null } | null {
  const m = /^@?([\w.]+)\s*(?:\(([\s\S]*)\))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!, args: m[2] ?? null };
}
const simpleName = (n: string): string => n.slice(n.lastIndexOf(".") + 1);

/** The string a decorator argument holds under one of `keys` (or positionally), `"a" + "b"` joined; null when not literal. */
function stringArg(args: string | null, keys: readonly string[]): string | null {
  if (args === null) return null;
  const parts = splitArgs(args);
  let positional: string | null = null;
  for (const [i, part] of parts.entries()) {
    const eq = /^\s*(\w+)\s*=(?!=)([\s\S]*)$/.exec(part);
    if (eq) {
      if (keys.includes(eq[1]!)) return literal(eq[2]!);
    } else if (i === 0) positional = literal(part);
  }
  return keys.includes("value") ? positional : null;
}

/** An annotation's or a signature's arguments at the top level; Java strings in double quotes, with escapes. */
function splitArgs(text: string): string[] {
  return splitTopLevel(text, { quotes: '"', escapes: '"' });
}

/** `"a" + "b"` → `ab`; anything else (a constant, a Kotlin raw string, an array) → null. */
function literal(expr: string): string | null {
  const text = /^\s*"""[ \t]*\r?\n([\s\S]*?)"""\s*$/.exec(expr);
  if (text) return text[1]!.includes("$") || text[1]!.includes("\\") ? null : text[1]!.replace(/\s+/g, " ").trim();
  const re = /^\s*"((?:[^"\\]|\\.)*)"\s*(?:\+|$)/;
  let rest = expr;
  let out = "";
  let first = true;
  while (rest.trim() !== "") {
    const m = re.exec(rest);
    if (!m) return null;
    if (m[1]!.includes("$")) return null;
    out += m[1]!.replace(/\\(["\\])/g, "$1");
    rest = rest.slice(m[0].length);
    first = false;
  }
  return first ? null : out;
}

function collectAspects(analyses: readonly FileAnalysis[]): Aspect[] {
  const out: Aspect[] = [];
  for (const file of analyses) {
    for (const cls of file.classes) {
      if (!cls.decorators?.some((d) => simpleName(parseDecorator(d)?.name ?? "") === "Aspect")) continue;
      const aspect: Aspect = { file, cls, advice: [], pointcuts: new Map() };
      for (const method of cls.methods) {
        for (const d of method.decorators ?? []) {
          const dec = parseDecorator(d);
          if (!dec) continue;
          const kind = simpleName(dec.name);
          if (kind === "Pointcut") {
            const expr = stringArg(dec.args, ["value"]);
            if (expr !== null) aspect.pointcuts.set(method.name, expr);
          } else if (ADVICE_KINDS.has(kind)) {
            const expr = stringArg(dec.args, kind === "AfterReturning" || kind === "AfterThrowing" ? ["value", "pointcut"] : ["value"]);
            if (expr !== null) aspect.advice.push({ kind, method, expression: expr });
          }
        }
      }
      if (aspect.advice.length > 0 || aspect.pointcuts.size > 0) out.push(aspect);
    }
  }
  return out;
}

// ── Project index ──────────────────────────────────────────────────────────────────────────────

interface JoinPoint {
  file: FileAnalysis;
  cls: ClassInfo;
  method: FunctionInfo;
}

class ProjectIndex {
  readonly joinPoints: JoinPoint[] = [];
  private readonly byFqn = new Map<string, Array<{ file: FileAnalysis; cls: ClassInfo }>>();
  private readonly bySimple = new Map<string, Array<{ file: FileAnalysis; cls: ClassInfo }>>();
  private readonly supers = new Map<ClassInfo, Array<{ fqn: string; cls: ClassInfo }>>();
  /** Named pointcuts parsed once per run, by their text. */
  readonly parsedPointcuts = new Map<string, Node | null>();
  /** `execution(...)` atoms compiled once per run, by their text. */
  readonly executions = new Map<string, CompiledExecution | null>();
  /** Dotted type patterns split into segments once per run. */
  readonly segments = new Map<string, string[]>();

  constructor(analyses: readonly FileAnalysis[]) {
    for (const file of analyses) {
      for (const cls of file.classes) {
        const entry = { file, cls };
        const fqn = fqnOf(file, cls);
        (this.byFqn.get(fqn) ?? this.byFqn.set(fqn, []).get(fqn)!).push(entry);
        (this.bySimple.get(cls.name) ?? this.bySimple.set(cls.name, []).get(cls.name)!).push(entry);
        if (isTestFile(file.filePath, file.language)) continue;
        for (const method of cls.methods) {
          // A private method is no join point (no proxy reaches it); a constructor is none either.
          if (method.name === "constructor" || method.name === cls.name || method.synthetic || (method.isExported === false && cls.kind !== "interface")) continue;
          this.joinPoints.push({ file, cls, method });
        }
      }
    }
  }

  fqnOf(jp: JoinPoint): string {
    return fqnOf(jp.file, jp.cls);
  }

  classByFqn(fqn: string): { file: FileAnalysis; cls: ClassInfo } | null {
    const hits = this.byFqn.get(fqn);
    return hits?.length === 1 ? hits[0]! : null;
  }

  /** The project supertypes of a class (transitively), by the simple name the class writes, when exactly one project class bears it. */
  supertypesOf(file: FileAnalysis, cls: ClassInfo): Array<{ fqn: string; cls: ClassInfo }> {
    const cached = this.supers.get(cls);
    if (cached) return cached;
    const out: Array<{ fqn: string; cls: ClassInfo }> = [];
    this.supers.set(cls, out);
    const seen = new Set<ClassInfo>([cls]);
    const queue: Array<{ file: FileAnalysis; cls: ClassInfo }> = [{ file, cls }];
    while (queue.length > 0 && out.length < 64) {
      const cur = queue.shift()!;
      for (const written of [cur.cls.extends, ...(cur.cls.implements ?? [])]) {
        if (!written) continue;
        const target = this.resolveWritten(cur.file, written);
        if (!target || seen.has(target.cls)) continue;
        seen.add(target.cls);
        out.push({ fqn: fqnOf(target.file, target.cls), cls: target.cls });
        queue.push(target);
      }
    }
    return out;
  }

  /** A type as a file writes it (`ClubService`, `com.example.Repo<Club>`) → the one project class it names. */
  resolveWritten(file: FileAnalysis, written: string): { file: FileAnalysis; cls: ClassInfo } | null {
    const bare = written.replace(/<[\s\S]*$/, "").trim();
    if (bare.includes(".")) return this.classByFqn(bare);
    const fqn = resolveSimpleName(file, bare);
    if (fqn) return this.classByFqn(fqn);
    const hits = (this.bySimple.get(bare) ?? []).filter((h) => (h.file.packageName ?? "") === (file.packageName ?? ""));
    return hits.length === 1 ? hits[0]! : null;
  }
}

/** A bare name written in `file`'s own package, fully qualified. */
function qualify(file: FileAnalysis, name: string): string {
  return file.packageName ? `${file.packageName}.${name}` : name;
}

function fqnOf(file: FileAnalysis, cls: ClassInfo): string {
  return qualify(file, cls.name);
}

/**
 * A bare type name → its fully qualified name through the file's imports (single or wildcard) or, with `index`, its own
 * package when exactly that class is declared there; null when unknown. A single import names its type by the name it
 * binds: the last segment, or the alias (`ImportInfo.aliases`, Kotlin `import a.Mechanic as Fixer` — the original name is
 * then no longer in scope); a static import (`inScope`) binds a member, never a type — unless the project declares a class of exactly that name (a Kotlin lower-case class).
 */
function resolveSimpleName(file: FileAnalysis, name: string, index?: ProjectIndex): string | null {
  for (const imp of file.imports) {
    if (imp.isNamespace || (imp.inScope && !index?.classByFqn(imp.source))) continue;
    const aliased = imp.aliases && Object.keys(imp.aliases).length > 0;
    if (aliased ? imp.aliases![name] === simpleName(imp.source) : simpleName(imp.source) === name) return imp.source;
  }
  // A wildcard import names the type only when exactly one imported package of the project declares it.
  if (index) {
    const hits = file.imports.filter((i) => i.isNamespace && index.classByFqn(`${i.source}.${name}`));
    if (hits.length === 1) return `${hits[0]!.source}.${name}`;
    const own = qualify(file, name);
    if (index.classByFqn(own)) return own;
  }
  return null;
}

/** Is annotation `written` (as a file writes it) the annotation type `fqn`? */
function namesAnnotation(file: FileAnalysis, written: string, fqn: string): boolean {
  if (simpleName(written) !== simpleName(fqn)) return false;
  if (written.includes(".")) return written === fqn;
  const imported = resolveSimpleName(file, written);
  if (imported) return imported === fqn;
  const pkg = fqn.slice(0, fqn.lastIndexOf("."));
  if (file.imports.some((i) => i.isNamespace && i.source === pkg)) return true;
  return (file.packageName ?? "") === pkg;
}

// ── Pointcut expressions ───────────────────────────────────────────────────────────────────────

type Node =
  | { t: "and" | "or"; l: Node; r: Node }
  | { t: "not"; e: Node }
  | { t: "atom"; name: string; arg: string };

/** `a && !b(x) || (c)` → a tree; null when the text is not a well-formed expression. Linear in the text. */
function parsePointcut(text: string): Node | null {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const parseOr = (): Node | null => {
    let left = parseAnd();
    while (left) {
      ws();
      if (text.startsWith("||", i)) {
        i += 2;
        const right = parseAnd();
        if (!right) return null;
        left = { t: "or", l: left, r: right };
      } else break;
    }
    return left;
  };
  const parseAnd = (): Node | null => {
    let left = parseNot();
    while (left) {
      ws();
      if (text.startsWith("&&", i)) {
        i += 2;
        const right = parseNot();
        if (!right) return null;
        left = { t: "and", l: left, r: right };
      } else break;
    }
    return left;
  };
  const parseNot = (): Node | null => {
    ws();
    if (text[i] === "!") {
      i++;
      const e = parseNot();
      return e ? { t: "not", e } : null;
    }
    if (text[i] === "(") {
      i++;
      const e = parseOr();
      ws();
      if (!e || text[i] !== ")") return null;
      i++;
      return e;
    }
    const m = /^@?[\w.$]+/.exec(text.slice(i, i + 200));
    if (!m) return null;
    i += m[0].length;
    ws();
    if (text[i] !== "(") return null;
    const start = ++i;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    if (depth !== 0) return null;
    return { t: "atom", name: m[0], arg: text.slice(start, i - 1).trim() };
  };
  const root = parseOr();
  ws();
  return root && i === text.length ? root : null;
}

type Tri = boolean | undefined;

interface EvalContext {
  index: ProjectIndex;
  aspects: readonly Aspect[];
  aspect: Aspect;
  /** The advice method's parameters (name → type), for `@annotation(audited)` bindings. */
  advice: Map<string, string>;
  jp: JoinPoint;
  depth: number;
}

function evalNode(n: Node, ctx: EvalContext): Tri {
  switch (n.t) {
    case "and": {
      const l = evalNode(n.l, ctx);
      if (l === false) return false;
      const r = evalNode(n.r, ctx);
      if (r === false) return false;
      return l === true && r === true ? true : undefined;
    }
    case "or": {
      const l = evalNode(n.l, ctx);
      if (l === true) return true;
      const r = evalNode(n.r, ctx);
      if (r === true) return true;
      return l === false && r === false ? false : undefined;
    }
    case "not": {
      const v = evalNode(n.e, ctx);
      return v === undefined ? undefined : !v;
    }
    case "atom":
      return evalAtom(n, ctx);
  }
}

function evalAtom(n: Extract<Node, { t: "atom" }>, ctx: EvalContext): Tri {
  switch (n.name) {
    case "execution":
      return matchExecution(n.arg, ctx);
    case "within":
      return matchWithin(n.arg, ctx);
    case "@annotation":
      return matchAnnotation(n.arg, ctx, "method");
    case "@within":
      return matchAnnotation(n.arg, ctx, "class");
    default:
      return n.name.startsWith("@") || DESIGNATORS.has(n.name) ? undefined : evalNamed(n.name, ctx);
  }
}

const DESIGNATORS = new Set(["args", "this", "target", "bean", "within", "call", "get", "set", "handler", "initialization", "preinitialization", "staticinitialization", "cflow", "cflowbelow", "adviceexecution", "if", "withincode"]);

/** A named pointcut, `clubOps()` in the aspect's own class or `Other.clubOps()` / `pkg.Other.clubOps()` of one other aspect. */
function evalNamed(name: string, ctx: EvalContext): Tri {
  if (ctx.depth >= 8) return undefined;
  const dot = name.lastIndexOf(".");
  const method = name.slice(dot + 1);
  let owner: Aspect | undefined;
  if (dot < 0) owner = ctx.aspect.pointcuts.has(method) ? ctx.aspect : undefined;
  else {
    const typeName = name.slice(0, dot);
    const hits = ctx.aspects.filter((a) => a.pointcuts.has(method) && (fqnOf(a.file, a.cls) === typeName || a.cls.name === typeName));
    owner = hits.length === 1 ? hits[0] : undefined;
  }
  if (!owner) return undefined;
  const text = owner.pointcuts.get(method)!;
  let expr = ctx.index.parsedPointcuts.get(text);
  if (expr === undefined) ctx.index.parsedPointcuts.set(text, (expr = parsePointcut(text)));
  if (!expr) return undefined;
  return evalNode(expr, { ...ctx, aspect: owner, depth: ctx.depth + 1 });
}

// ── Designators ────────────────────────────────────────────────────────────────────────────────

const MODIFIERS = new Set(["public", "protected", "private", "static", "final", "abstract", "synchronized", "native", "!public", "!protected", "!private", "!static", "!final"]);

/** An `execution(...)` atom read once: its modifiers, name glob, return, parameter patterns and declaring type. */
interface CompiledExecution {
  modifiers: string[];
  namePattern: string;
  ret: string;
  params: string;
  typePattern: string | null;
  plus: boolean;
}

/** The atom's text taken apart once per run (shared by every advice and join point); null when it is not a form this reads. */
function compileExecution(arg: string): CompiledExecution | null {
  const open = arg.indexOf("(");
  if (open < 0) return null;
  const close = matchingParen(arg, open);
  if (close < 0) return null;
  if (arg.slice(close + 1).trim() !== "") return null; // `throws …`
  const head = arg.slice(0, open).trim().split(/\s+/);
  const modifiers: string[] = [];
  while (head.length > 2) {
    const mod = head.shift()!;
    if (!MODIFIERS.has(mod)) return null;
    modifiers.push(mod);
  }
  if (head.length !== 2) return null;
  const [ret, decl] = head as [string, string];
  const dot = decl.lastIndexOf(".");
  const typePattern = dot < 0 ? null : decl.slice(0, dot);
  if (typePattern !== null && typePattern.endsWith(".")) return null;
  return { modifiers, namePattern: decl.slice(dot + 1), ret, params: arg.slice(open + 1, close), typePattern, plus: typePattern?.endsWith("+") ?? false };
}

function matchExecution(arg: string, ctx: EvalContext): Tri {
  let atom = ctx.index.executions.get(arg);
  if (atom === undefined) ctx.index.executions.set(arg, (atom = compileExecution(arg)));
  if (!atom) return undefined;
  // The name glob settles most join points: fail on it before any other work.
  if (!globMatch(atom.namePattern, ctx.jp.method.name)) return false;
  let modifierOk: Tri = true;
  for (const mod of atom.modifiers) {
    if (mod === "public") modifierOk = ctx.jp.method.isExported || ctx.jp.cls.kind === "interface" ? modifierOk : false;
    else modifierOk = modifierOk === false ? false : undefined;
  }
  if (modifierOk === false) return false;
  const results: Tri[] = [modifierOk, matchReturn(atom.ret, ctx.jp.method.returnType), matchParams(atom.params, ctx.jp.method)];
  if (atom.typePattern !== null) results.push(matchTypePattern(atom.typePattern, declaringNames(ctx, atom.plus), ctx));
  if (results.includes(false)) return false;
  return results.every((r) => r === true) ? true : undefined;
}

/** Fully qualified names of the types a join point may be said to be declared in: its class, and the supertypes that declare the same name (every supertype for a `+` pattern). */
function declaringNames(ctx: EvalContext, allSupers: boolean): string[] {
  const { index, jp } = ctx;
  const names = [index.fqnOf(jp)];
  for (const s of index.supertypesOf(jp.file, jp.cls)) {
    if (allSupers || s.cls.methods.some((m) => m.name === jp.method.name)) names.push(s.fqn);
  }
  return names;
}

function matchWithin(arg: string, ctx: EvalContext): Tri {
  // `within(@org.springframework.stereotype.Service *)`: a type bearing the annotation, and named by the rest.
  const annotated = /^@([\w.]+)\s+(\S+)$/.exec(arg.trim());
  if (annotated) {
    const [, anno, rest] = annotated as unknown as [string, string, string];
    if (!anno.includes(".")) return undefined;
    const has = (ctx.jp.cls.decorators ?? []).some((d) => {
      const dec = parseDecorator(d);
      return dec !== null && namesAnnotation(ctx.jp.file, dec.name, anno);
    });
    if (!has) return false;
    return matchWithin(rest, ctx);
  }
  const plus = arg.endsWith("+");
  const names = plus ? declaringNames(ctx, true) : [ctx.index.fqnOf(ctx.jp)];
  return matchTypePattern(arg, names, ctx);
}

function matchAnnotation(arg: string, ctx: EvalContext, on: "method" | "class"): Tri {
  let fqn = arg.trim();
  if (!fqn) return undefined;
  if (!fqn.includes(".")) {
    // `@annotation(audited)` binds the advice parameter `audited`; its type names the annotation.
    const type = ctx.advice.get(fqn);
    if (!type) return undefined;
    // Only a type the aspect's imports or its own package certainly name; a guess would make `!@annotation(x)` true.
    const written = type.trim();
    const resolved = resolveSimpleName(ctx.aspect.file, written, ctx.index);
    if (!resolved) return undefined;
    fqn = resolved;
  }
  if (/[*+]/.test(fqn)) return undefined;
  const decorators = on === "method" ? ctx.jp.method.decorators : ctx.jp.cls.decorators;
  for (const d of decorators ?? []) {
    const dec = parseDecorator(d);
    if (dec && namesAnnotation(ctx.jp.file, dec.name, fqn)) return true;
  }
  return false;
}

function matchReturn(pattern: string, returnType: string | null | undefined): Tri {
  if (pattern === "*") return true;
  if (/[+!]|\.\./.test(pattern)) return undefined;
  if (!returnType) return undefined;
  const have = simpleName(returnType.replace(/<[\s\S]*$/, "").trim());
  return globMatch(simpleName(pattern.replace(/<[\s\S]*$/, "")), have);
}

function matchParams(pattern: string, method: FunctionInfo): Tri {
  const wanted = pattern.trim() === "" ? [] : splitArgs(pattern).map((p) => p.trim());
  if (wanted.some((w) => w.endsWith("+") || w.startsWith("!"))) return undefined;
  // A nullable, array or varargs type is written differently in a pattern: say nothing certain.
  if (method.params.some((p) => p.type && /[\[?]|\.\.\./.test(p.type))) return wanted.every((w) => w === "..") ? true : undefined;
  const have = method.params.map((p) => (p.type ? simpleName(p.type.replace(/<[\s\S]*$/, "").replace(/\s/g, "")) : null));
  if (have.some((h) => h === null) && wanted.some((w) => w !== ".." && w !== "*")) return undefined;
  // Zero or more parameters for `..`, exactly one for anything else: a dynamic program, never a backtracking search.
  let row = new Array<boolean>(have.length + 1).fill(false);
  row[0] = true;
  for (const w of wanted) {
    const next = new Array<boolean>(have.length + 1).fill(false);
    if (w === "..") {
      let any = false;
      for (let j = 0; j <= have.length; j++) {
        any = any || row[j]!;
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= have.length; j++) next[j] = row[j - 1]! && (w === "*" || globMatch(simpleName(w), have[j - 1]!) === true);
    }
    row = next;
  }
  return row[have.length]!;
}

/** `*` within one name: any run of characters. Two-pointer, linear in the longer string per `*`-run. */
function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** A dotted type pattern against fully qualified names: `..` is zero or more whole segments, `*` stays in its segment. */
function matchTypePattern(pattern: string, names: readonly string[], ctx: EvalContext): Tri {
  let p = pattern.trim();
  if (p.endsWith("+")) p = p.slice(0, -1);
  if (p.startsWith("!") || p.includes("&&") || p.includes("||")) return undefined;
  if (p === "*" || p === "..") return true;
  if (!p.includes(".")) {
    // A bare class name is resolved where the aspect is written; a wildcard without a package says nothing certain.
    if (/\*/.test(p)) return undefined;
    const fqn = resolveSimpleName(ctx.aspect.file, p, ctx.index);
    if (!fqn) return undefined;
    p = fqn;
  }
  let segments = ctx.index.segments.get(p);
  if (!segments) ctx.index.segments.set(p, (segments = patternSegments(p)));
  return names.some((name) => matchSegments(segments, name.split("."))) ? true : false;
}

const SEQ = "..";

function patternSegments(p: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ".") {
      if (p[i + 1] === ".") {
        if (cur) out.push(cur);
        cur = "";
        out.push(SEQ);
        i++;
      } else {
        out.push(cur);
        cur = "";
      }
    } else cur += p[i];
  }
  if (cur) out.push(cur);
  return out;
}

/** Dynamic program over (pattern segment, name segment): O(P·N), the `..` of a pattern never re-scans. */
function matchSegments(pattern: readonly string[], name: readonly string[]): boolean {
  let row = new Array<boolean>(name.length + 1).fill(false);
  row[0] = true;
  for (const seg of pattern) {
    const next = new Array<boolean>(name.length + 1).fill(false);
    if (seg === SEQ) {
      let any = false;
      for (let j = 0; j <= name.length; j++) {
        any = any || row[j]!;
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= name.length; j++) next[j] = row[j - 1]! && globMatch(seg, name[j - 1]!);
    }
    row = next;
  }
  return row[name.length]!;
}
