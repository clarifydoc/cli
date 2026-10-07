import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";

type LocalTypes = NonNullable<FunctionInfo["localTypes"]>;

/** `let [mut] name[: Type] = rhs` — the rest after `=` is read separately. */
const LET_RE = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::\s*([^=;]+?))?\s*(?:=\s*(.*))?$/;
/** Any other binding the body makes: `let (a, b)`, `if let Some(x)`, `for x in`, `|x, y|`. */
const PATTERN_BINDINGS: RegExp[] = [
  /\blet\s+(?:mut\s+)?([(\[{&][^=]*|[A-Z]\w*(?:::\w+)*\s*[({][^=]*)=/g,
  /\bfor\s+(.+?)\s+in\b/g,
  /\|([^|]*)\|/g,
];
/** Wrappers whose `::new(x)` is a value of x's type as far as member calls go (auto-deref). */
const DEREF_WRAPPERS = /^(?:std::(?:sync|rc)::|std::boxed::)?(?:Arc|Rc|Box)::new\((.*)\)$/s;

/**
 * Locals whose type the body states:
 *
 *   let r: Arc<dyn UserRepo> = …            → Arc<dyn UserRepo> (the declared type wins)
 *   let r = PgRepo::new(…) / ::default()    → PgRepo (`?`, `.unwrap()`, `.expect(…)` allowed after)
 *   let r = PgRepo { dsn };                 → PgRepo
 *   let r = Arc::new(PgRepo::new(…));       → PgRepo (Arc/Rc/Box deref to it)
 *
 * Types are kept as written (`Arc<dyn UserRepo>`, `crate::repo::PgRepo`,
 * `Self` — the impl pass resolves `Self` and generic parameters). A name
 * bound again with another or an unknown type (`let r = r.inner();`, a
 * `for`/`if let`/closure binding of the same name), or shadowing a parameter
 * of another type, is left out — which binding a call sees cannot be told.
 */
export function extractRustLocalTypes(bodyLines: string[], params: readonly ParamInfo[]): LocalTypes {
  const seen = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  const record = (name: string, type: string | null): void => {
    if (name === "_" || name === "self") return;
    if (type === null) { unknown.add(name); return; }
    let set = seen.get(name);
    if (!set) seen.set(name, (set = new Set()));
    set.add(type.replace(/\s+/g, " ").trim());
  };

  for (const raw of bodyLines) {
    if (!raw.includes("let") && !raw.includes("for") && !raw.includes("|")) continue;
    const line = blankStringLiterals(raw.replace(/\/\/.*$/, ""));
    for (const statement of line.split(";")) {
      const m = LET_RE.exec(statement);
      if (m && !/\b(?:if|while)\s+let\b/.test(statement.slice(0, m.index + 3))) {
        record(m[1]!, m[2] ? m[2].trim() : m[3] !== undefined ? initializerType(m[3]) : null);
      }
      for (const re of PATTERN_BINDINGS) {
        re.lastIndex = 0;
        let b: RegExpExecArray | null;
        while ((b = re.exec(statement)) !== null) {
          for (const id of b[1]!.matchAll(/\b([a-z_]\w*)\b/g)) {
            if (id[1] !== "mut" && id[1] !== "ref") record(id[1]!, null);
          }
        }
      }
      const iflet = /\b(?:if|while)\s+let\s+(.+?)=/.exec(statement);
      if (iflet) for (const id of iflet[1]!.matchAll(/\b([a-z_]\w*)\b/g)) if (id[1] !== "mut" && id[1] !== "ref") record(id[1]!, null);
    }
  }

  const out: LocalTypes = [];
  for (const [name, types] of seen) {
    if (unknown.has(name) || types.size !== 1) continue;
    const type = [...types][0]!;
    const param = params.find((p) => p.name === name);
    if (param && param.type !== type) continue;
    out.push({ name, type });
  }
  return out;
}

/** The type a `let` initializer constructs, or null when it does not plainly construct one. */
function initializerType(rhs: string): string | null {
  let text = rhs.trim().replace(/\s*;?\s*$/, "");
  // Unwrapping a constructor's Result/Option keeps the constructed type.
  text = text.replace(/(?:\?|\.unwrap\(\)|\.expect\([^()]*\))$/, "").trim();
  const wrapped = DEREF_WRAPPERS.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  const ctor = /^((?:[A-Za-z_]\w*::)*[A-Z]\w*)(?:::<[^>]*>)?::(?:new|default)\s*\((.*)$/s.exec(text);
  // The whole initializer is the call — its argument list closes at the end,
  // or continues on the next lines.
  if (ctor && closesAtEndOrNever(ctor[2]!, "(", ")")) return ctor[1]!;
  const lit = /^((?:[A-Za-z_]\w*::)*[A-Z]\w*)\s*\{(.*)$/s.exec(text);
  if (lit && closesAtEndOrNever(lit[2]!, "{", "}")) return lit[1]!;
  return null;
}

/** `text` follows an opening bracket: true when that bracket closes at its very end, or not on this line. */
function closesAtEndOrNever(text: string, open: string, close: string): boolean {
  let depth = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(i + 1).trim() === "";
  }
  return true;
}
