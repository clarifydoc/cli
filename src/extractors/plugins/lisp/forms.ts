import type { CallInfo, ClassInfo, ExportInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { isKeyword, isSymbol, type Form, type SeqForm } from "../shared/sexpr.js";

export type LispDialect = "racket" | "scheme" | "commonlisp";

/** Forms that are syntax, binding or plumbing — never a call to link. */
const SPECIAL = new Set([
  "define", "define-values", "define-syntax", "define-syntax-rule", "lambda", "λ", "case-lambda", "let", "let*", "letrec",
  "letrec*", "let-values", "let*-values", "flet", "labels", "macrolet", "if", "cond", "case", "when", "unless", "and", "or",
  "not", "begin", "begin0", "progn", "prog1", "prog2", "set!", "setf", "setq", "incf", "decf", "push", "pop", "quote",
  "quasiquote", "unquote", "do", "dolist", "dotimes", "loop", "for", "for/list", "for/fold", "for*/list", "for/hash",
  "for/vector", "for/and", "for/or", "for/sum", "for/first", "for*", "match", "match-define", "match-let", "values",
  "parameterize", "with-handlers", "handler-case", "handler-bind", "unwind-protect", "ignore-errors", "with-slots",
  "with-accessors", "multiple-value-bind", "destructuring-bind", "block", "return", "return-from", "tagbody", "go",
  "catch", "throw", "declare", "the", "function", "else", "=>", "assert", "error", "raise", "delay", "force", "guard",
  "receive", "call-with-values", "dynamic-wind", "with-open-file", "with-output-to-string", "format", "list", "cons",
  "car", "cdr", "first", "rest", "second", "third", "append", "map", "mapcar", "filter", "foldl", "foldr", "reduce",
  "length", "null?", "null", "eq?", "eqv?", "equal?", "eq", "eql", "equal", "+", "-", "*", "/", "=", "<", ">", "<=", ">=",
  "string-append", "displayln", "display", "printf", "newline", "print", "write", "void", "hash-ref", "hash-set!",
  "gethash", "getf", "assoc", "member", "vector-ref", "list-ref", "nth", "apply", "funcall", "send", "super-new",
  "new", "make-instance", "struct-copy", "in-list", "in-range", "in-naturals", "string=?", "string?", "number?",
  "zero?", "add1", "sub1", "1+", "1-", "max", "min", "abs", "exact->inexact", "number->string", "string->number",
  "symbol->string", "string->symbol", "vector", "make-hash", "hash", "list?", "pair?", "else", "require", "provide",
]);

const LAMBDA_HEADS = new Set(["lambda", "λ", "case-lambda", "opt-lambda"]);
/** A function's lambda-list words that are no parameters. */
const LAMBDA_LIST_KEYWORDS = new Set(["&optional", "&key", "&rest", "&body", "&aux", "&allow-other-keys", "&whole", "&environment", "."]);

export interface LispFile {
  functions: FunctionInfo[];
  classes: ClassInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  /** Calls of the file's own top-level statements (`<setup>`). */
  setup: CallInfo[];
}

function seq(f: Form | undefined): SeqForm | null {
  return f && (f.kind === "list" || f.kind === "vector") ? f : null;
}
function head(f: Form | undefined): string | null {
  const s = seq(f);
  return s && isSymbol(s.items[0]) ? s.items[0].name : null;
}
/** A Lisp name as the linker reads it: `db:find` and `shop.db/find` stay one token. */
function symName(f: Form | undefined): string | null {
  if (isSymbol(f)) return f.name;
  if (isKeyword(f)) return f.name;
  if (f?.kind === "string") return f.value;
  return null;
}
function endOf(f: Form): number {
  return "endLine" in f && f.endLine ? f.endLine : f.line;
}

/** Forms that bind names: `(let ((x (f))) …)` — the binding list is no call. */
const BINDING_FORMS = new Set(["let", "let*", "letrec", "letrec*", "let-values", "let*-values", "do", "do*", "fluid-let", "parameterize", "with-slots", "with-accessors"]);
/** Local function definitions: `(flet ((helper (a) body)) …)`. */
const LOCAL_FUNCTION_FORMS = new Set(["flet", "labels", "macrolet"]);
/** Forms that register a handler to run later — at load only the registering form runs. */
export const DEFERRED_FORMS = new Set(["defroute", "define-easy-handler", "define-handler", "defhandler"]);

/**
 * The calls in `body` forms: every list headed by a name that is not syntax
 * and not bound locally — `(find-order id)`, `(db:query …)`; Racket's
 * `(send repo save o)` is `repo.save`, `(funcall #'f x)` / `(apply f xs)` call `f`.
 * Binding lists (`lambda`'s parameters, `let` bindings, `cond`/`case`/`match`
 * clause heads) are read as what they are. A nested `lambda` belongs to its
 * function (it has no name of its own) — unless `deferLambdas`: at load time
 * a lambda is a value, its body runs later (a route handler).
 */
export function callsIn(body: readonly Form[], bound: ReadonlySet<string> = new Set(), deferLambdas = false): CallInfo[] {
  const out: CallInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, line: number) => {
    if (seen.has(name) || bound.has(name) || SPECIAL.has(name) || /^[\d#:&"]/.test(name)) return;
    seen.add(name);
    out.push({ name, kind: "internal", target: null, line, column: 0 });
  };
  const visitAll = (forms: readonly Form[]) => { for (const c of forms) visit(c, false); };
  const visit = (f: Form, quoted: boolean): void => {
    const s = seq(f);
    if (!s) return;
    if (quoted || s.kind === "vector") { for (const c of s.items) visit(c, true); return; }
    const h = head(s);
    if (!h) { visitAll(s.items); return; }
    const items = s.items;
    if (h === "quote") return;
    if (LAMBDA_HEADS.has(h)) { if (!deferLambdas) visitAll(items.slice(2)); return; }
    // A route definition is a definition (read as a route), not a call.
    if (DEFERRED_FORMS.has(h.replace(/^[\w.-]+:/, "")) && deferLambdas) return;
    if (BINDING_FORMS.has(h)) {
      // A named `let` (`(let loop ((i 0)) …)`) puts its name before the bindings.
      const at = isSymbol(items[1]) ? 2 : 1;
      for (const b of seq(items[at])?.items ?? []) visitAll(seq(b)?.items.slice(1) ?? []);
      visitAll(items.slice(at + 1));
      return;
    }
    if (LOCAL_FUNCTION_FORMS.has(h)) {
      for (const b of seq(items[1])?.items ?? []) visitAll(seq(b)?.items.slice(2) ?? []);
      visitAll(items.slice(2));
      return;
    }
    if (h === "define") {
      visitAll(seq(items[1]) ? items.slice(2) : items.slice(2));
      return;
    }
    if (h === "cond") { for (const clause of items.slice(1)) visitAll(seq(clause)?.items ?? [clause]); return; }
    if (h === "case" || h === "match" || h === "ecase" || h === "typecase" || h === "etypecase") {
      visit(items[1]!, false);
      for (const clause of items.slice(2)) visitAll(seq(clause)?.items.slice(1) ?? []);
      return;
    }
    if (h === "send" && isSymbol(items[1]) && isSymbol(items[2])) add(`${items[1].name}.${items[2].name}`, s.line);
    else if ((h === "funcall" || h === "apply") && isSymbol(items[1])) add(items[1].name, s.line);
    else add(h, s.line);
    visitAll(items.slice(1));
  };
  visitAll(body);
  return out;
}

/** Parameters of a lambda list: `(a b . rest)`, `(a &optional (b 1) &key c)`, `(a #:kw [k 1])`, `((o order) x)`. */
export function lambdaList(list: readonly Form[]): ParamInfo[] {
  const out: ParamInfo[] = [];
  for (const p of list) {
    if (isKeyword(p)) continue; // Racket `#:kw` — the parameter follows
    if (isSymbol(p)) {
      if (!LAMBDA_LIST_KEYWORDS.has(p.name)) out.push({ name: p.name, type: null, defaultValue: null });
      continue;
    }
    const s = seq(p);
    if (!s || !isSymbol(s.items[0])) continue;
    // `(b 1)` optional with default, `(o order)` a CLOS specializer, `[k 1]` Racket optional.
    const second = s.items[1];
    const specializer = s.items.length === 2 && isSymbol(second) && !/^[\d"#]/.test(second.name);
    out.push({
      name: s.items[0].name,
      type: specializer ? second.name : null,
      defaultValue: !specializer && second ? printShort(second) : null,
    });
  }
  return out;
}

function printShort(f: Form): string {
  switch (f.kind) {
    case "string": return `"${f.value}"`;
    case "keyword": return `:${f.name}`;
    case "symbol": return f.name;
    case "number": return f.value;
    default: return "(…)";
  }
}

function fn(name: string, params: ParamInfo[], body: readonly Form[], span: Form, exported = true): FunctionInfo {
  const bound = new Set(params.map((p) => p.name));
  return {
    name, params, returnType: null, isAsync: false, isExported: exported, decorators: [],
    calls: callsIn(body, bound), line: span.line, endLine: endOf(span),
  };
}

function blankClass(name: string, span: Form): ClassInfo {
  return { name, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: true, line: span.line, endLine: endOf(span) };
}

function prop(name: string, type: string | null = null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}

/** A library name `(shop db)` → `shop/db`; a string path → `./path`; a symbol as written. */
function moduleSource(f: Form | undefined, dialect: LispDialect): string | null {
  if (!f) return null;
  if (f.kind === "string") return /^\.{1,2}\//.test(f.value) || /^[a-z]+:/.test(f.value) ? f.value : `./${f.value}`;
  if (isSymbol(f) || isKeyword(f)) return dialect === "commonlisp" ? f.name.replace(/^#?:/, "").toLowerCase() : f.name;
  const s = seq(f);
  if (!s) return null;
  // Racket's `(only-in "db.rkt" find)` / `(prefix-in db: "db.rkt")`, R7RS `(only (shop db) find)`.
  const h = head(s);
  if (h && /^(?:only-in|except-in|prefix-in|rename-in|only|except|prefix|rename|file)$/.test(h)) return moduleSource(h === "prefix-in" || h === "prefix" ? s.items[2] ?? s.items[1] : s.items[1], dialect);
  if (s.items.every((i) => isSymbol(i) || i.kind === "number")) return s.items.map((i) => printShort(i)).join("/");
  return null;
}

/**
 * Read a file's definitions from its forms. One walk serves the three
 * dialects; each spells definitions its own way:
 *  - Racket: `define`, `define/contract`, `struct`, `class` (`define/public` methods),
 *    `require`/`provide`, `module`/`module+` (a `test` submodule is skipped);
 *  - Scheme: `define`, `define-record-type`, `define-library` / Guile
 *    `define-module` + `use-modules`, `import`, `include`/`load`;
 *  - Common Lisp: `defun`, `defmacro`, `defmethod` (its specializer is the
 *    parameter's type), `defclass`, `defstruct`, `defpackage` (`:use`,
 *    `:import-from`, `:export`), `ql:quickload`.
 */
export function readLispFile(forms: readonly Form[], dialect: LispDialect): LispFile {
  const file: LispFile = { functions: [], classes: [], imports: [], exports: [], setup: [] };
  const imported = new Set<string>();
  const addImport = (source: string | null, line: number, specifiers: string[] = []) => {
    if (!source || imported.has(source) || /^(?:cl|common-lisp|racket|racket\/base|scheme|scheme\/base|guile|rnrs)$/i.test(source)) return;
    imported.add(source);
    file.imports.push({ source, specifiers, isDefault: false, isNamespace: specifiers.length === 0, isType: false, line });
  };
  const addExport = (name: string | null, line: number) => {
    if (name && !file.exports.some((e) => e.name === name)) file.exports.push({ name, kind: "function", line });
  };
  const setupForms: Form[] = [];

  const visit = (f: Form, topLevel: boolean) => {
    const s = seq(f);
    const h = head(f);
    if (!s || !h) { if (topLevel) setupForms.push(f); return; }
    const items = s.items;
    switch (h) {
      case "define": case "define/contract": case "define/public": case "define/private": case "define*": case "define-public": {
        const target = items[1];
        const sig = seq(target);
        if (sig && isSymbol(sig.items[0])) {
          // `(define (f a b) body…)` — `define/contract` puts the contract before the body.
          const body = items.slice(h === "define/contract" ? 3 : 2);
          file.functions.push(fn(sig.items[0].name, lambdaList(sig.items.slice(1)), body, s, h !== "define/private"));
          if (h === "define-public") addExport(sig.items[0].name, s.line);
          return;
        }
        if (isSymbol(target)) {
          const value = items[h === "define/contract" ? 3 : 2];
          const vh = head(value);
          if (vh && LAMBDA_HEADS.has(vh)) {
            const v = seq(value)!;
            const params = seq(v.items[1]) ? lambdaList(seq(v.items[1])!.items) : [];
            file.functions.push(fn(target.name, params, v.items.slice(2), s));
            return;
          }
          if (vh === "class" || vh === "class*") {
            file.classes.push(racketClass(target.name, seq(value)!));
            return;
          }
          // `(define app (dispatch-rules …))` — a value computed at load.
          if (topLevel && value) setupForms.push(value);
        }
        return;
      }
      case "define-syntax-rule": case "defmacro": case "define-macro": {
        const sig = seq(items[1]);
        const name = sig && isSymbol(sig.items[0]) ? sig.items[0].name : symName(items[1]);
        if (name) file.functions.push(fn(name, sig ? lambdaList(sig.items.slice(1)) : lambdaList(seq(items[2])?.items ?? []), items.slice(sig ? 2 : 3), s));
        return;
      }
      case "defun": {
        const name = symName(items[1]);
        if (name) file.functions.push(fn(name, lambdaList(seq(items[2])?.items ?? []), items.slice(3), s));
        return;
      }
      case "defmethod": {
        const name = symName(items[1]);
        // Qualifiers (`:before`, `:around`) sit between the name and the lambda list.
        const idx = items.findIndex((x, i) => i > 1 && seq(x) !== null);
        if (name && idx > 0) file.functions.push(fn(name, lambdaList(seq(items[idx])!.items), items.slice(idx + 1), s));
        return;
      }
      case "defclass": case "define-class": {
        const name = symName(items[1]);
        if (!name) return;
        const cls = blankClass(name, s);
        const supers = seq(items[2])?.items.map(symName).filter((x): x is string => !!x) ?? [];
        cls.extends = supers[0] ?? null;
        cls.implements = supers.slice(1);
        for (const slot of seq(items[3])?.items ?? []) {
          const slotSeq = seq(slot);
          const slotName = symName(slotSeq ? slotSeq.items[0] : slot);
          if (!slotName) continue;
          const typeIdx = slotSeq?.items.findIndex((x) => isKeyword(x, "type")) ?? -1;
          cls.properties.push(prop(slotName, typeIdx >= 0 ? symName(slotSeq!.items[typeIdx + 1]) : null));
        }
        file.classes.push(cls);
        return;
      }
      case "defstruct": {
        const nameSpec = seq(items[1]);
        const name = symName(nameSpec ? nameSpec.items[0] : items[1]);
        if (!name) return;
        const cls = blankClass(name, s);
        const include = nameSpec?.items.map(seq).find((o) => o && isKeyword(o.items[0], "include"));
        if (include) cls.extends = symName(include.items[1]);
        for (const slot of items.slice(2)) {
          if (slot.kind === "string") continue;
          const slotSeq = seq(slot);
          const slotName = symName(slotSeq ? slotSeq.items[0] : slot);
          const typeIdx = slotSeq?.items.findIndex((x) => isKeyword(x, "type")) ?? -1;
          if (slotName) cls.properties.push(prop(slotName, typeIdx >= 0 ? symName(slotSeq!.items[typeIdx + 1]) : null));
        }
        file.classes.push(cls);
        return;
      }
      case "struct": case "define-struct": {
        // `(struct point (x y))`, `(struct point3 point (z))`.
        const name = symName(items[1]);
        if (!name) return;
        const cls = blankClass(name, s);
        const fieldsAt = seq(items[2]) ? 2 : 3;
        if (fieldsAt === 3) cls.extends = symName(items[2]);
        for (const field of seq(items[fieldsAt])?.items ?? []) {
          const fname = symName(seq(field) ? seq(field)!.items[0] : field);
          if (fname) cls.properties.push(prop(fname));
        }
        file.classes.push(cls);
        return;
      }
      case "define-record-type": {
        // `(define-record-type <point> (make-point x y) point? (x point-x) (y point-y set-point-y!))`.
        const name = symName(seq(items[1]) ? seq(items[1])!.items[0] : items[1])?.replace(/^<(.*)>$/, "$1");
        if (!name) return;
        const cls = blankClass(name, s);
        for (const field of items.slice(4)) {
          const fname = symName(seq(field)?.items[0]);
          if (fname) cls.properties.push(prop(fname));
        }
        file.classes.push(cls);
        return;
      }
      case "require": case "use-modules": case "import": case "use": {
        for (const spec of items.slice(1)) {
          const sq = seq(spec);
          const sh = head(spec);
          const specifiers = sh && /^(?:only-in|only)$/.test(sh) ? sq!.items.slice(2).map(symName).filter((x): x is string => !!x) : [];
          addImport(moduleSource(spec, dialect), spec.line, specifiers);
        }
        return;
      }
      case "include": case "load": case "include-ci": {
        addImport(moduleSource(items[1], dialect), s.line);
        return;
      }
      case "ql:quickload": case "quicklisp:quickload": {
        const target = items[1];
        for (const t of seq(target)?.items ?? [target]) addImport(moduleSource(t, "commonlisp"), s.line);
        return;
      }
      case "provide": {
        for (const p of items.slice(1)) {
          const ph = head(p);
          if (ph === "struct-out") addExport(symName(seq(p)!.items[1]), s.line);
          else if (!ph) addExport(symName(p), s.line);
        }
        return;
      }
      case "defpackage": case "define-package": case "uiop:define-package": {
        for (const opt of items.slice(2)) {
          const o = seq(opt);
          if (!o || !isKeyword(o.items[0])) continue;
          const key = (o.items[0] as { name: string }).name;
          if (key === "use") for (const p of o.items.slice(1)) addImport(moduleSource(p, "commonlisp"), o.line);
          if (key === "import-from" || key === "shadowing-import-from") addImport(moduleSource(o.items[1], "commonlisp"), o.line, o.items.slice(2).map(symName).filter((x): x is string => !!x));
          if (key === "export") for (const e of o.items.slice(1)) addExport(symName(e), o.line);
        }
        return;
      }
      case "define-module": {
        // Guile: `(define-module (shop web) #:use-module (shop db) #:export (start))`.
        for (let i = 2; i < items.length; i++) {
          if (isKeyword(items[i], "use-module")) addImport(moduleSource(items[i + 1], dialect), s.line);
          if (isKeyword(items[i], "export")) for (const e of seq(items[i + 1])?.items ?? []) addExport(symName(e), s.line);
        }
        return;
      }
      case "define-library": {
        for (const decl of items.slice(2)) {
          const dh = head(decl);
          const d = seq(decl)!;
          if (dh === "import") for (const spec of d.items.slice(1)) addImport(moduleSource(spec, dialect), d.line);
          else if (dh === "export") for (const e of d.items.slice(1)) addExport(symName(e), d.line);
          else if (dh === "begin") for (const b of d.items.slice(1)) visit(b, false);
          else if (dh === "include") addImport(moduleSource(d.items[1], dialect), d.line);
        }
        return;
      }
      case "module": case "module*": {
        for (const b of items.slice(3)) visit(b, topLevel);
        return;
      }
      case "module+": {
        // A `test` submodule is the file's tests; `main` runs when the file is run.
        if (isSymbol(items[1], "test")) return;
        for (const b of items.slice(2)) visit(b, topLevel);
        return;
      }
      case "begin": case "progn": case "eval-when": case "begin-for-syntax": {
        for (const b of items.slice(h === "eval-when" ? 2 : 1)) visit(b, topLevel);
        return;
      }
      case "in-package": case "declaim": case "defvar": case "defparameter": case "defconstant": case "defgeneric": case "define-values": {
        if ((h === "defvar" || h === "defparameter") && topLevel && items[2]) setupForms.push(items[2]);
        return;
      }
      default:
        if (topLevel) setupForms.push(f);
    }
  };
  for (const f of forms) visit(f, true);
  file.setup = callsIn(setupForms, new Set(), true);
  return file;
}

/** A Racket `(class object% (super-new) (init-field id) (field [total 0]) (define/public (close) …))`. */
function racketClass(name: string, value: SeqForm): ClassInfo {
  const cls = blankClass(name, value);
  cls.extends = symName(value.items[head(value) === "class*" ? 1 : 1]) ?? null;
  if (head(value) === "class*") cls.implements = seq(value.items[2])?.items.map(symName).filter((x): x is string => !!x) ?? [];
  for (const member of value.items.slice(2)) {
    const mh = head(member);
    const m = seq(member);
    if (!m || !mh) continue;
    if (/^define\/(?:public|override|pubment|augment|private|overment|augride|public-final|override-final)$/.test(mh)) {
      const sig = seq(m.items[1]);
      if (sig && isSymbol(sig.items[0])) cls.methods.push(fn(sig.items[0].name, lambdaList(sig.items.slice(1)), m.items.slice(2), m, mh !== "define/private"));
    } else if (/^(?:init-field|field|init)$/.test(mh)) {
      for (const f of m.items.slice(1)) {
        const fname = symName(seq(f) ? seq(f)!.items[0] : f);
        if (fname) cls.properties.push(prop(fname));
      }
    }
  }
  return cls;
}
