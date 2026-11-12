/**
 * Callable value flow (the solver behind the `value-flow` link strategy).
 *
 * A function is often not called by its name: it is stored in a local, handed on as an argument, kept in a
 * field or a list, returned from a factory, and run later through whatever holds it. Plugins state the
 * steps as neutral facts (`FunctionInfo.valueFlow`, `FileAnalysis.moduleValueFlow`: seed, copy, arg, result,
 * return, invoke); this module joins them, language-agnostically, into the functions each invoke site runs.
 *
 * Inclusion-based (Andersen style), flow- and context-insensitive: every cell holds a set of functions, a copy
 * makes the source's set part of the destination's, and a worklist runs until nothing changes. Which functions
 * a call reaches (needed to bind its arguments to formals and its result to a cell) comes from the ordinary
 * links at that call site plus what the solver itself finds the call's cell holding, so both grow together.
 *
 * A cell that would hold more than `MAX_TARGETS` functions is poisoned: it stands for nothing and passes that
 * on to every cell, argument and invoke it feeds, so a catch-all holder never fabricates edges. A work budget
 * bounds the whole run; past it nothing is emitted.
 */
import type { ClassInfo, FileAnalysis, FunctionInfo, PropertyInfo, SymbolLink, ValueCell, ValueFlowFact } from "../types/analysis.js";

/** At most this many functions a cell may hold before it is poisoned. */
const MAX_TARGETS = 32;
/** Up to this many targets an invoke is INFERRED; above it, AMBIGUOUS. */
const INFERRED_TARGETS = 4;
/** A lambda held in a value stands for at most this many project functions (and held values it runs); more, and it stands for none. */
const LAMBDA_TARGETS = 4;
/** Propagation steps allowed per run (plus a share per fact). */
const BASE_BUDGET = 2_000_000;
const BUDGET_PER_FACT = 200;

const RECEIVER_NAMES = new Set(["this", "self"]);
/** A cell name standing for the file's own module binding named by `member`: how a function writes a global it does not declare. */
export const MODULE_CELL = "<module>";
const CONSTRUCTOR_NAMES = ["constructor", "__init__", "__construct", "init", "new"];

/** What the solver asks of the linker (callbacks, so this module imports nothing of it). */
export interface ValueFlowHost {
  analyses: readonly FileAnalysis[];
  /** The links the name tiers produced; their call sites say what each call reaches. */
  links: readonly SymbolLink[];
  /** A function named as written, resolved from `symbol`'s scope without guessing: null when it is none. */
  resolveSeed(file: string, symbol: string, name: string, line: number): { file: string; symbol: string; line: number } | null;
  /** The project class a declared type names (as seen from `file`), or null. */
  classOfType(file: string, type: string): { file: string; name: string } | null;
  /** The class `name` of `file` extends, located in the project. */
  parentOf(file: string, name: string): { file: string; name: string } | null;
  /** The class `name` declares in `file`. */
  classAt(file: string, name: string): ClassInfo | undefined;
  /** The file (and the name it exports) an imported local name leads to; `namespace` for `import * as x`. */
  importedBinding(file: string, name: string): { file: string; name: string; namespace: boolean } | null;
  /** A test file, or a test double's. */
  isTest(file: string): boolean;
  /** One line of progress, shown in verbose runs. */
  note?(message: string): void;
}

/** `file\0symbol\0line\0call`: how a call site is named across passes. */
export function callSiteKey(file: string, symbol: string, line: number, call: string): string {
  return `${file}\0${symbol}\0${line}\0${call}`;
}

/** Where a function's own facts live: a top-level function, a method (`Class.method`) or a file's `<setup>`. */
interface Scope {
  file: string;
  symbol: string;
  analysis: FileAnalysis;
  fn: FunctionInfo | null;
  cls: ClassInfo | null;
  facts: readonly ValueFlowFact[];
}

function* scopesOf(analysis: FileAnalysis): Generator<Scope> {
  const setup = analysis.functions.find((f) => f.name === "<setup>") ?? null;
  const moduleFacts = analysis.moduleValueFlow ?? [];
  for (const fn of analysis.functions) {
    const facts = fn === setup ? [...(fn.valueFlow ?? []), ...moduleFacts] : fn.valueFlow ?? [];
    yield { file: analysis.filePath, symbol: fn.name, analysis, fn, cls: null, facts };
  }
  for (const cls of analysis.classes) {
    for (const m of cls.methods) yield { file: analysis.filePath, symbol: `${cls.name}.${m.name}`, analysis, fn: m, cls, facts: m.valueFlow ?? [] };
  }
  if (!setup && moduleFacts.length > 0) yield { file: analysis.filePath, symbol: "<setup>", analysis, fn: null, cls: null, facts: moduleFacts };
}

/**
 * The call sites plugins marked as invoking a held value (`invoke` facts), and how far the name tiers may still
 * resolve each: `suppress` — never, so a global namesake cannot claim a call that runs whatever a cell holds (the
 * cell is a parameter, or a seed or copy writes it); `same-file` — a plain name only a call's result writes, or
 * nothing (`const f = debounce(g)`, `useCallback(…)`: a value the facts do not follow), keeps a link into its own
 * file only. A member no seed or copy writes anywhere (`this.model.apply()` on an object field) is left to the name tiers entirely.
 */
export function valueFlowInvokeSites(analyses: readonly FileAnalysis[]): Map<string, "suppress" | "same-file"> {
  const out = new Map<string, "suppress" | "same-file">();
  const writtenMembers = new Set<string>();
  // Only a seed or a copy says what a cell holds; a call's result (`debounce(load)`) is a value the facts do not follow.
  const writes = (f: ValueFlowFact): ValueCell | null => (f.kind === "seed" || f.kind === "copy" ? f.to : null);
  for (const a of analyses) for (const s of scopesOf(a)) for (const f of s.facts) {
    const to = writes(f);
    if (to?.member !== undefined) writtenMembers.add(to.member);
  }
  for (const a of analyses) {
    const moduleWritten = new Set<string>();
    for (const s of scopesOf(a)) for (const f of s.facts) {
      const to = writes(f);
      if (!to) continue;
      if (to.name === MODULE_CELL && to.member !== undefined) moduleWritten.add(to.member);
      else if (to.module || s.fn === null || s.fn.name === "<setup>") moduleWritten.add(to.name);
    }
    for (const s of scopesOf(a)) {
      let local: Set<string> | null = null;
      for (const f of s.facts) {
        if (f.kind !== "invoke") continue;
        const key = callSiteKey(s.file, s.symbol, f.line, f.call);
        const { name, member } = f.cell;
        if (member !== undefined) {
          if (writtenMembers.has(member) || name === MODULE_CELL) out.set(key, "suppress");
          continue;
        }
        if (!local) {
          local = new Set();
          for (const g of s.facts) { const to = writes(g); if (to && to.member === undefined) local.add(to.name); }
        }
        const isParam = s.fn?.params.some((p) => p.name === name) ?? false;
        out.set(key, isParam || local.has(name) || moduleWritten.has(name) ? "suppress" : "same-file");
      }
    }
  }
  return out;
}

/** Whether any file states value-flow facts (the pass costs nothing when none does). */
export function hasValueFlowFacts(analyses: readonly FileAnalysis[]): boolean {
  for (const a of analyses) {
    if (a.moduleValueFlow?.length) return true;
    for (const fn of a.functions) if (fn.valueFlow?.length) return true;
    for (const c of a.classes) for (const m of c.methods) if (m.valueFlow?.length) return true;
  }
  return false;
}

interface Target { file: string; symbol: string; line: number }
interface InvokeSite { scope: Scope; call: string; line: number; key: string }
interface ArgUse { index: number; cell: number; name?: string }

/** Solve the value flow and return one `value-flow` link per (invoke site, target). */
export function solveValueFlow(host: ValueFlowHost): SymbolLink[] {
  const { analyses } = host;
  if (!hasValueFlowFacts(analyses)) return [];

  const scopes: Scope[] = [];
  let factCount = 0;
  for (const a of analyses) for (const s of scopesOf(a)) { scopes.push(s); factCount += s.facts.length; }
  const budget = BASE_BUDGET + factCount * BUDGET_PER_FACT;

  const analysisAt = new Map(analyses.map((a) => [a.filePath, a]));
  /** `file\0symbol` → its scope, for formals and returns. */
  const scopeAt = new Map<string, Scope>();
  for (const s of scopes) scopeAt.set(`${s.file}\0${s.symbol}`, s);
  // Functions and methods without facts own formals and returns too.
  for (const a of analyses) {
    for (const c of a.classes) for (const m of c.methods) {
      const key = `${a.filePath}\0${c.name}.${m.name}`;
      if (!scopeAt.has(key)) scopeAt.set(key, { file: a.filePath, symbol: `${c.name}.${m.name}`, analysis: a, fn: m, cls: c, facts: [] });
    }
    for (const f of a.functions) {
      const key = `${a.filePath}\0${f.name}`;
      if (!scopeAt.has(key)) scopeAt.set(key, { file: a.filePath, symbol: f.name, analysis: a, fn: f, cls: null, facts: [] });
    }
  }

  // ── Cells ────────────────────────────────────────────────────────────────
  const cellIds = new Map<string, number>();
  const cellOfKey = (key: string): number => {
    let id = cellIds.get(key);
    if (id === undefined) { id = cellIds.size; cellIds.set(key, id); }
    return id;
  };

  /** Names a scope binds itself: parameters, typed locals and the destination of its own facts. */
  const boundCache = new Map<Scope, Set<string>>();
  const boundNames = (s: Scope): Set<string> => {
    let set = boundCache.get(s);
    if (set) return set;
    set = new Set();
    // A file's `<setup>` binds module names, never locals: its facts feed `moduleBound` below.
    if (s.symbol !== "<setup>") {
      for (const p of s.fn?.params ?? []) set.add(p.name);
      for (const l of s.fn?.localTypes ?? []) set.add(l.name);
      for (const f of s.facts) {
        if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member === undefined && !f.to.module) set.add(f.to.name);
      }
    }
    boundCache.set(s, set);
    return set;
  };
  /** Names the file's module facts bind. */
  const moduleBound = new Map<string, Set<string>>();
  /** Names a file's module facts give a value of their own (a call's result, another name's value), not only functions stored into them. */
  const moduleRebound = new Map<string, Set<string>>();
  for (const s of scopes) {
    if (s.symbol !== "<setup>") continue;
    const set = new Set<string>();
    const rebound = new Set<string>();
    for (const f of s.facts) {
      if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member === undefined) {
        set.add(f.to.name);
        if (f.kind === "result" || (f.kind === "copy" && f.from.name !== f.to.name)) rebound.add(f.to.name);
      }
    }
    moduleBound.set(s.file, set);
    moduleRebound.set(s.file, rebound);
  }
  // A function's write to a module name it does not declare (`ValueCell.module`) binds that name for the whole file.
  for (const s of scopes) {
    for (const f of s.facts) {
      if ((f.kind !== "seed" && f.kind !== "copy" && f.kind !== "result") || !f.to.module) continue;
      let set = moduleBound.get(s.file);
      if (!set) moduleBound.set(s.file, (set = new Set()));
      set.add(f.to.name);
    }
  }

  /** The innermost enclosing top-level function that binds `name` (a closure reads its parent's locals). */
  /** The innermost enclosing top-level function that binds `name` (a closure reads its parent's locals). */
  // A function that writes a module binding it does not declare (`{ name: "<module>", member: "handler" }`) binds it for the file.
  for (const s of scopes) {
    for (const f of s.facts) {
      const to = f.kind === "seed" || f.kind === "copy" || f.kind === "result" ? f.to : null;
      if (to?.name !== MODULE_CELL || !to.member) continue;
      const set = moduleBound.get(s.file) ?? moduleBound.set(s.file, new Set()).get(s.file)!;
      set.add(to.member);
    }
  }

  const enclosingBinder = (s: Scope, name: string): Scope | null => {
    if (!s.fn || s.cls || s.symbol === "<setup>") return null;
    let best: Scope | null = null;
    const consider = (g: FunctionInfo, symbol: string): void => {
      if (g === s.fn || g.name === "<setup>" || g.line > s.fn!.line || g.endLine < s.fn!.endLine) return;
      const gs = scopeAt.get(`${s.file}\0${symbol}`);
      if (!gs || !boundNames(gs).has(name)) return;
      if (!best || g.endLine - g.line < best.fn!.endLine - best.fn!.line) best = gs;
    };
    // A closure reads the locals of the function (or method) it is written in.
    for (const g of s.analysis.functions) consider(g, g.name);
    for (const c of s.analysis.classes) for (const m of c.methods) consider(m, `${c.name}.${m.name}`);
    return best;
  };

  const typeOfName = (s: Scope, name: string): string | null => {
    const p = s.fn?.params.find((x) => x.name === name);
    if (p?.type) return p.type;
    const l = s.fn?.localTypes?.find((x) => x.name === name && x.type && !x.aliasOf);
    return l?.type ?? null;
  };

  const fieldCell = (file: string, cls: string, member: string): number => {
    // The class (own, then bases) that declares the member keeps it; else the named class.
    let cur: { file: string; name: string } | null = { file, name: cls };
    for (let depth = 0; cur && depth < 16; depth++) {
      const info = host.classAt(cur.file, cur.name);
      if (info?.properties.some((p) => p.name === member)) return cellOfKey(`F\0${cur.file}\0${cur.name}\0${member}`);
      cur = host.parentOf(cur.file, cur.name);
    }
    return cellOfKey(`F\0${file}\0${cls}\0${member}`);
  };

  /** The declared type of the property `name` of class `cls` or the class it extends, or null. */
  const propertyTypeOf = (file: string, cls: string, name: string): string | null => {
    let cur: { file: string; name: string } | null = { file, name: cls };
    for (let depth = 0; cur && depth < 16; depth++) {
      const prop = host.classAt(cur.file, cur.name)?.properties.find((p) => p.name === name);
      if (prop) return prop.type ?? null;
      cur = host.parentOf(cur.file, cur.name);
    }
    return null;
  };

  /** The base a name stands for: a local/param, a module name, or an imported one. */
  type Base = { kind: "local"; key: string } | { kind: "module"; file: string; name: string; namespace?: boolean };
  const baseOf = (s: Scope, name: string): Base | null => {
    if (boundNames(s).has(name)) return { kind: "local", key: `L\0${s.file}\0${s.symbol}\0${name}` };
    const outer = enclosingBinder(s, name);
    if (outer) return { kind: "local", key: `L\0${outer.file}\0${outer.symbol}\0${name}` };
    const imported = host.importedBinding(s.file, name);
    // A name the file imports is the exporting file's when this file's module facts only store functions into it
    // (a static set from another module); one it gives a value of its own (`handler = wrap(handler)`) is rebound here.
    if ((!imported || moduleRebound.get(s.file)?.has(name)) && moduleBound.get(s.file)?.has(name)) return { kind: "module", file: s.file, name };
    if (imported) return { kind: "module", file: imported.file, name: imported.name, namespace: imported.namespace };
    return null;
  };

  /** The class a root of a field path stands for: the receiver's, a typed local's or parameter's, or a class named as written. */
  const ownerOf = (s: Scope, root: string): { file: string; name: string } | null => {
    if (RECEIVER_NAMES.has(root)) return s.cls ? { file: s.file, name: s.cls.name } : null;
    if (baseOf(s, root)) {
      const type = typeOfName(s, root);
      return type ? host.classOfType(s.file, type) : null;
    }
    return host.classOfType(s.file, root);
  };
  /** The class a property of `owner` (or its bases) is declared to hold. */
  const propertyOwner = (owner: { file: string; name: string }, property: string): { file: string; name: string } | null => {
    let cur: { file: string; name: string } | null = owner;
    for (let depth = 0; cur && depth < 16; depth++) {
      const found: PropertyInfo | undefined = host.classAt(cur.file, cur.name)?.properties.find((p) => p.name === property);
      if (found) return found.type ? host.classOfType(cur.file, found.type) : null;
      cur = host.parentOf(cur.file, cur.name);
    }
    return null;
  };

  const cellOf = (s: Scope, cell: ValueCell): number | null => {
    const { name, member } = cell;
    if (cell.module) {
      // The file's own module binding (never an imported one), whatever the function binds.
      if (moduleBound.get(s.file)?.has(name)) return cellOfKey(`M\0${s.file}\0${name}${member === undefined ? "" : `.${member}`}`);
      return null;
    }
    if (name === MODULE_CELL) return member === undefined ? null : cellOfKey(`M\0${s.file}\0${member}`);
    if (member === undefined) {
      const base = baseOf(s, name);
      if (!base) return null;
      return cellOfKey(base.kind === "local" ? base.key : `M\0${base.file}\0${base.name}`);
    }
    if (RECEIVER_NAMES.has(name)) {
      if (s.cls) return fieldCell(s.file, s.cls.name, member);
      return cellOfKey(`L\0${s.file}\0${s.symbol}\0${name}.${member}`);
    }
    // A field path (`c.ops` + member `sign`): each step is the declared type of the property before it.
    if (name.includes(".")) {
      const [root, ...path] = name.split(".");
      let owner = ownerOf(s, root!);
      for (const step of path) {
        if (!owner) return null;
        owner = propertyOwner(owner, step);
      }
      return owner ? fieldCell(owner.file, owner.name, member) : null;
    }
    const base = baseOf(s, name);
    if (!base) {
      // A property of the enclosing class (or a base's) the plugin says is read by its bare name (`widget.onSave`): its type owns the member;
      // otherwise an unbound name that is a project class: the member is that class's own (`Club.handler`, a struct type's table).
      const type = cell.field && s.cls ? propertyTypeOf(s.file, s.cls.name, name) : null;
      const owner = type ? host.classOfType(s.file, type) : cell.field ? null : host.classOfType(s.file, name);
      return owner ? fieldCell(owner.file, owner.name, member) : null;
    }
    if (base.kind === "module") {
      return cellOfKey(base.namespace ? `M\0${base.file}\0${member}` : `M\0${base.file}\0${base.name}.${member}`);
    }
    const type = typeOfName(s, name);
    const owner = type ? host.classOfType(s.file, type) : null;
    if (owner) return fieldCell(owner.file, owner.name, member);
    // Untyped local: the member is this function's own.
    return cellOfKey(`${base.key}.${member}`);
  };

  const resultCellOf = (file: string, symbol: string): number => cellOfKey(`R\0${file}\0${symbol}`);

  // ── Static call-site knowledge ───────────────────────────────────────────
  const staticCallees = new Map<string, Set<string>>();
  for (const l of host.links) {
    if (l.relation !== "calls" && l.relation !== "instantiates" && l.relation !== "dispatch") continue;
    if (l.navigational) continue;
    const key = callSiteKey(l.sourceFile, l.sourceSymbol, l.sourceLine, l.callName);
    let set = staticCallees.get(key);
    if (!set) staticCallees.set(key, (set = new Set()));
    set.add(`${l.targetFile}\0${l.targetSymbol}`);
  }

  // ── Graph state ──────────────────────────────────────────────────────────
  const targets: Target[] = [];
  const targetIds = new Map<string, number>();
  const pts: Array<Set<number> | undefined> = [];
  const poisoned = new Set<number>();
  const succ = new Map<number, Set<number>>();
  const invokesAt = new Map<number, InvokeSite[]>();
  const argsOfSite = new Map<string, ArgUse[]>();
  const resultsOfSite = new Map<string, number[]>();
  const calleesOfSite = new Map<string, Set<string>>();
  const queue: number[] = [];
  const queued = new Set<number>();
  let head = 0;
  let steps = 0;

  const enqueue = (c: number): void => { if (!queued.has(c)) { queued.add(c); queue.push(c); } };
  const poison = (c: number): void => {
    if (poisoned.has(c)) return;
    poisoned.add(c);
    pts[c] = undefined;
    enqueue(c);
  };
  const addTarget = (c: number, t: number): void => {
    if (poisoned.has(c)) return;
    const set = (pts[c] ??= new Set());
    if (set.has(t)) return;
    if (set.size >= MAX_TARGETS) { poison(c); return; }
    set.add(t);
    enqueue(c);
  };
  const flow = (from: number, to: number): void => {
    if (from === to) return;
    steps++;
    if (poisoned.has(to)) return;
    if (poisoned.has(from)) { poison(to); return; }
    const src = pts[from];
    if (!src) return;
    for (const t of src) { addTarget(to, t); if (poisoned.has(to)) return; }
  };
  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    let set = succ.get(from);
    if (!set) succ.set(from, (set = new Set()));
    if (set.has(to)) return;
    set.add(to);
    flow(from, to);
  };

  /** The function a callee symbol means (a class symbol stands for its constructor). */
  const calleeScope = (key: string): { scope: Scope; offset: number } | null => {
    let s = scopeAt.get(key);
    if (!s) {
      const at = key.indexOf("\0");
      const file = key.slice(0, at);
      const symbol = key.slice(at + 1);
      const cls = analysisAt.get(file)?.classes.find((c) => c.name === symbol);
      const ctor = cls?.methods.find((m) => CONSTRUCTOR_NAMES.includes(m.name) || m.name === cls.name);
      if (!cls || !ctor) return null;
      s = scopeAt.get(`${file}\0${cls.name}.${ctor.name}`);
    }
    if (!s?.fn) return null;
    const first = s.fn.params[0];
    const offset = s.cls && first && (RECEIVER_NAMES.has(first.name) || first.name === "cls" || first.isReceiver) ? 1 : 0;
    return { scope: s, offset };
  };

  const addCallee = (site: string, callee: string): void => {
    let set = calleesOfSite.get(site);
    if (!set) calleesOfSite.set(site, (set = new Set()));
    if (set.has(callee)) return;
    set.add(callee);
    const args = argsOfSite.get(site);
    const results = resultsOfSite.get(site);
    if (!args && !results) return;
    const target = calleeScope(callee);
    if (!target) return;
    const { scope, offset } = target;
    for (const a of args ?? []) {
      const formal = a.name !== undefined ? scope.fn!.params.find((x) => x.name === a.name) : scope.fn!.params[a.index + offset];
      if (!formal || formal.variadic) continue;
      addEdge(a.cell, cellOfKey(`L\0${scope.file}\0${scope.symbol}\0${formal.name}`));
    }
    for (const r of results ?? []) addEdge(resultCellOf(scope.file, scope.symbol), r);
  };

  const targetId = (t: Target): number => {
    // Keyed by line too: two nested functions of one name in a file (`_handler` in two factories) are two targets.
    const key = `${t.file}\0${t.symbol}\0${t.line}`;
    let id = targetIds.get(key);
    if (id === undefined) { id = targets.length; targetIds.set(key, id); targets.push(t); }
    return id;
  };

  // ── Facts → graph ────────────────────────────────────────────────────────
  const sitesWithFacts = new Set<string>();
  const invokeKeys = new Set<string>();
  const addInvoke = (cell: number, inv: InvokeSite): void => {
    const id = `${cell}\0${inv.key}`;
    if (invokeKeys.has(id)) return;
    invokeKeys.add(id);
    (invokesAt.get(cell) ?? invokesAt.set(cell, []).get(cell)!).push(inv);
  };
  // A held lambda's facts share a `lambda` id: it stands for the project functions its body calls, counted here once
  // resolved (a library's name resolves to nothing and never counts), and for none when they and the held values it
  // runs are more than LAMBDA_TARGETS.
  const seedTargets = new Map<ValueFlowFact, Target | null>();
  const droppedLambdas = new Set<string>();
  for (const s of scopes) {
    const groups = new Map<string, { targets: Set<string>; copies: Set<string> }>();
    for (const f of s.facts) {
      if ((f.kind !== "seed" && f.kind !== "copy") || f.lambda === undefined) continue;
      const g = groups.get(f.lambda) ?? groups.set(f.lambda, { targets: new Set(), copies: new Set() }).get(f.lambda)!;
      // A held value counts once, however many facts copy it (a cell and its elements, a lambda read twice).
      if (f.kind === "copy") { g.copies.add(JSON.stringify(f.from)); continue; }
      const t = host.resolveSeed(s.file, s.symbol, f.fn, f.line);
      seedTargets.set(f, t);
      if (t) g.targets.add(`${t.file}\0${t.symbol}\0${t.line}`);
    }
    for (const [id, g] of groups) if (g.targets.size + g.copies.size > LAMBDA_TARGETS) droppedLambdas.add(`${s.file}\0${s.symbol}\0${id}`);
  }
  const dropped = (s: Scope, f: ValueFlowFact): boolean =>
    (f.kind === "seed" || f.kind === "copy") && f.lambda !== undefined && droppedLambdas.has(`${s.file}\0${s.symbol}\0${f.lambda}`);
  for (const s of scopes) {
    for (const f of s.facts) {
      if (dropped(s, f)) continue;
      switch (f.kind) {
        case "seed": {
          const to = cellOf(s, f.to);
          if (to === null) break;
          const t = seedTargets.has(f) ? seedTargets.get(f)! : host.resolveSeed(s.file, s.symbol, f.fn, f.line);
          if (t) addTarget(to, targetId(t));
          break;
        }
        case "copy": {
          const from = cellOf(s, f.from);
          const to = cellOf(s, f.to);
          if (from !== null && to !== null) addEdge(from, to);
          break;
        }
        case "arg": {
          const from = cellOf(s, f.from);
          if (from === null) break;
          const site = callSiteKey(s.file, s.symbol, f.line, f.call);
          (argsOfSite.get(site) ?? argsOfSite.set(site, []).get(site)!).push({ index: f.index, cell: from, ...(f.name !== undefined ? { name: f.name } : {}) });
          sitesWithFacts.add(site);
          break;
        }
        case "result": {
          const to = cellOf(s, f.to);
          if (to === null) break;
          const site = callSiteKey(s.file, s.symbol, f.line, f.call);
          (resultsOfSite.get(site) ?? resultsOfSite.set(site, []).get(site)!).push(to);
          sitesWithFacts.add(site);
          break;
        }
        case "return": {
          const from = cellOf(s, f.from);
          if (from !== null) addEdge(from, resultCellOf(s.file, s.symbol));
          break;
        }
        case "invoke": {
          const cell = cellOf(s, f.cell);
          if (cell !== null) addInvoke(cell, { scope: s, call: f.call, line: f.line, key: callSiteKey(s.file, s.symbol, f.line, f.call) });
          break;
        }
      }
    }
    // A bare call of a local or parameter (`boundLocally`) runs what that name holds.
    for (const call of s.fn?.calls ?? []) {
      if (!call.boundLocally || call.passed || call.read) continue;
      const parts = call.name.split(".");
      if (parts.length > 2) continue;
      const cell = cellOf(s, parts.length === 1 ? { name: call.name } : { name: parts[0]!, member: parts[1]! });
      if (cell !== null) addInvoke(cell, { scope: s, call: call.name, line: call.line, key: callSiteKey(s.file, s.symbol, call.line, call.name) });
    }
  }
  // The callees the name tiers found bind their formals and result cells.
  for (const site of sitesWithFacts) for (const callee of staticCallees.get(site) ?? []) addCallee(site, callee);

  // ── Fixpoint ─────────────────────────────────────────────────────────────
  for (let c = 0; c < pts.length; c++) if (pts[c]) enqueue(c);
  while (head < queue.length) {
    if (steps > budget) {
      host.note?.(`value-flow: work budget of ${budget} steps exhausted; no value-flow links emitted`);
      return [];
    }
    const c = queue[head++]!;
    queued.delete(c);
    steps++;
    for (const to of succ.get(c) ?? []) flow(c, to);
    const held = pts[c];
    if (poisoned.has(c) || !held) continue;
    for (const inv of invokesAt.get(c) ?? []) {
      for (const t of held) {
        const target = targets[t]!;
        addCallee(inv.key, `${target.file}\0${target.symbol}`);
      }
    }
    if (head > 4096 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
  }

  // ── Links ────────────────────────────────────────────────────────────────
  const out: SymbolLink[] = [];
  const emitted = new Set<string>();
  for (const [cell, sites] of invokesAt) {
    if (poisoned.has(cell)) continue;
    const held = pts[cell];
    if (!held || held.size === 0) continue;
    const confidence = held.size <= INFERRED_TARGETS ? "INFERRED" : "AMBIGUOUS";
    for (const inv of sites) {
      const productionSource = !host.isTest(inv.scope.file);
      for (const t of held) {
        const target = targets[t]!;
        if (productionSource && host.isTest(target.file)) continue;
        const key = `${inv.key}\0${target.file}\0${target.symbol}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        out.push({
          sourceFile: inv.scope.file, sourceSymbol: inv.scope.symbol, sourceLine: inv.line, callName: inv.call,
          targetFile: target.file, targetSymbol: target.symbol, targetLine: target.line,
          confidence, strategy: "value-flow", relation: "calls", resolvedBy: "text",
        });
      }
    }
  }
  return out;
}
