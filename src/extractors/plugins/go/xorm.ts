import type { DataSourceInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * xorm — the ORM gitea and many Go services use. Its sessions carry no entity
 * of their own: the entity is the argument the terminal verb is handed.
 *
 *   db.GetEngine(ctx).Where("repo_id = ?", id).Find(&labels)      // labels := make([]*Label, 0)
 *   e.ID(id).Get(issue)                                          // issue *Issue (a parameter)
 *   sess.Insert(&Comment{…})
 *   db.Find[repo_model.Topic](ctx, opts)   db.Insert(ctx, review)    // gitea's generic helpers
 *
 * A file is read only when it states xorm (`xorm.io/…`, `db.GetEngine(`,
 * `NewSession(`). Within it, a terminal verb (Find/Get/Insert/Update/Delete/…)
 * is a database access when its statement — a chain may continue over lines
 * ending in `.` — starts at an engine (`db.GetEngine(…)`, a session/engine
 * local) or passes through a builder step (`Where`, `ID`, `In`, `Table`, …).
 * The entity: a type argument (`db.Find[pkg.Topic]`), a struct literal or
 * `new(X)` in the argument, else the argument's declaration in the function —
 * `x := &X{…}`, `make([]*X, …)`, `var xs []X`, or a parameter `x *X`.
 */

/** One ORM's session shape: what marks a file as using it, its verbs, and where its chains start. */
interface OrmChainSpec {
  label: string;
  file: RegExp;
  terminal: RegExp;
  builder: RegExp;
  root: RegExp;
  reads: ReadonlySet<string>;
  /** A chain step naming the entity (`.Model(&Photo{})`), when the ORM has one. */
  model?: RegExp;
  generic?: RegExp;
  helper?: RegExp;
  /** A receiver declared as the ORM's session or engine type (`s *xorm.Session`) is one, whatever it is called. */
  session?: RegExp;
  /** A chain stored in a local and finished later (`s := Db().Table("clubs")…` … `s.Scan(&rows)`) is one chain. */
  builderVars?: boolean;
}

const XORM: OrmChainSpec = {
  label: "xorm",
  // `db.FindAndCount[T](…)` in a handler; a migration's `x base.EngineMigration` / `*xorm.Engine` parameter.
  file: /xorm\.io\/|\bdb\.GetEngine\(|\.NewSession\(\)|\bdb\.(?:Find|Get|GetByID|Count|Exist|Insert|DeleteByID|DeleteBeans|FindAndCount)\b|\bEngineMigration\b|\*xorm\.(?:Engine|Session)\b/,
  terminal: /(?:\.\s*|^\s*)(Find|FindAndCount|Get|Exist|Count|Iterate|Sum|SumInt|Sums|Insert|InsertOne|Update|Delete|Incr|Decr)\s*\(/g,
  builder: /\.\s*(?:Where|And|Or|ID|In|NotIn|Table|Cols|MustCols|AllCols|Select|OrderBy|Desc|Asc|Limit|Join|GroupBy|Having|Distinct|Omit|NoAutoCondition|Unscoped)\s*\(/,
  root: /^(?:db\.GetEngine\(|(?:e|x|sess\w*|session|engine|dbEngine|ss|eng)(?:\.|$))/,
  // `.Table("issue")` names the table the chain reads.
  model: /\.\s*Table\s*\(\s*("[\w.]+"|&?[A-Za-z_][\w.]*(?:\{\})?|new\(\s*[\w.]+\s*\))/,
  reads: new Set(["Find", "FindAndCount", "Get", "GetByID", "Exist", "Count", "Iterate", "Sum", "SumInt", "Sums"]),
  generic: /\bdb\.(Find|Get|GetByID|Count|Exist|DeleteByID|FindAndCount)\s*\[\s*(?:\*?[A-Za-z_]\w*\.)?\*?([A-Z]\w*)\s*\]\s*\(/g,
  helper: /\bdb\.(Insert|DeleteBeans|TruncateBeans)\s*\(\s*ctx\s*,\s*(&?[A-Za-z_][\w.]*(?:\{)?|new\(\s*[\w.]+\s*\))/g,
  session: /\*?xorm\.(?:Session|Engine|EngineGroup|Interface)\b|\bdb\.Engine\b/,
};

/**
 * GORM chains (photoprism): `UnscopedDb().Model(m).UpdateColumn(…)`,
 * `Db().Where("photo_id = ?", id).Delete(&PhotoLabel{})`. A receiver directly
 * named like a DB (`db.Find(&x)`) is the per-line GORM rule's; this one reads
 * the chains it cannot, and takes the entity from a `.Model(…)` step first.
 */
const GORM: OrmChainSpec = {
  label: "GORM",
  // Also a file that only chains on the project's own `Db()` / `UnscopedDb()` helper (no gorm import of its own).
  file: /gorm\.io\/gorm|jinzhu\/gorm|\*gorm\.DB\b|\b(?:[a-z_]\w*\.)?(?:Unscoped)?D[bB]\(\)\s*\.\s*(?:Where|Model|Table|Select|Raw|Exec|Joins|Preload|Unscoped|First|Find|Create|Save|Delete|Order)\b/,
  terminal: /(?:\.\s*|^\s*)(Find|First|Take|Last|Create|Save|Update|Updates|UpdateColumn|UpdateColumns|Delete|Count|Pluck|Scan|FirstOrCreate|FirstOrInit)\s*\(/g,
  builder: /\.\s*(?:Where|Not|Or|Model|Table|Select|Omit|Order|Limit|Offset|Group|Having|Joins|Preload|Unscoped|Debug|Session|WithContext|Distinct|Clauses)\s*\(/,
  root: /^(?:[A-Za-z_]\w*\.)?\w*(?:db|Db|DB|tx|Tx|orm|conn)\w*(?:\(\))?(?:\.|$)/,
  reads: new Set(["Find", "First", "Take", "Last", "Count", "Pluck", "Scan"]),
  model: /\.\s*(?:Model|Table)\s*\(\s*("[\w.]+"|&?[A-Za-z_][\w.]*\s*\{?|new\(\s*[\w.]+\s*\))/,
  builderVars: true,
};

export function extractXormDataSources(lines: string[]): DataSourceInfo[] {
  const gorm = extractOrmChains(lines, GORM);
  // A GORM file's `db.Insert`/`Unscoped()` are GORM's, not xorm's.
  return GORM.file.test(lines.join("\n")) ? gorm : [...extractOrmChains(lines, XORM), ...gorm, ...extractBuilderStatements(lines)];
}

const BUILDER_IMPORT = /"xorm\.io\/builder"/;
const BUILDER_VERB = /\bbuilder\.(Select|Insert|Update|Delete)\s*\(/g;

/**
 * xorm's SQL builder (`xorm.io/builder`) names the table a statement runs on:
 * `builder.Delete(cond).From("team_user")`, `builder.Select("uid").From("`user`")` (a subquery
 * a condition reads), `builder.Insert(eq).Into("stopwatch")`. One row per statement whose
 * chain — over lines — reaches a `.From`/`.Into` with a literal table; a read for `Select`.
 */
function extractBuilderStatements(lines: string[]): DataSourceInfo[] {
  const text = lines.join("\n");
  if (!BUILDER_IMPORT.test(text)) return [];
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const out: DataSourceInfo[] = [];
  for (const m of text.matchAll(BUILDER_VERB)) {
    let i = closeParen(text, m.index! + m[0].length - 1);
    let table: string | null = null;
    // The chain's steps, `.Where(…)` and the like, up to the one naming the table.
    for (let step = 0; i > 0 && step < 6 && table === null; step++) {
      const next = /^\s*\.\s*([A-Za-z]\w*)\s*\(/.exec(text.slice(i + 1, i + 200));
      if (!next) break;
      const open = i + 1 + next[0].length - 1;
      if (next[1] === "From" || next[1] === "Into") {
        table = /^\(\s*"`?([A-Za-z_][\w.]*)`?(?:\s+(?:AS\s+)?\w+)?"/i.exec(text.slice(open, open + 80))?.[1] ?? null;
        break;
      }
      i = closeParen(text, open);
    }
    if (!table) continue;
    out.push({
      kind: "database", name: `xorm builder: ${m[1]}`, target: table, entity: table,
      access: m[1] === "Select" ? "read" : "write", calls: [], line: lineAt(m.index!),
    });
  }
  return out;
}

/** The index of the `)` closing the `(` at `open` (strings skipped), or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "`") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function extractOrmChains(lines: string[], spec: OrmChainSpec): DataSourceInfo[] {
  if (!spec.file.test(lines.join("\n"))) return [];
  const out: DataSourceInfo[] = [];
  const READS = spec.reads;
  const row = (verb: string, entity: string | null, lineNo: number, target: string | null): DataSourceInfo => ({
    kind: "database",
    name: `${spec.label}: ${verb}`,
    // The argument's text names no store unless it is one (`&ids`, `&results` are the locals filled).
    target: entity ?? (target && /^"[\w.]+"$|^`[\w.]+`$/.test(target.trim()) ? target.trim().slice(1, -1) : null),
    ...(entity ? { entity } : {}),
    access: READS.has(verb) ? "read" : "write",
    calls: [],
    line: lineNo,
  });
  // Locals holding a chain, with the model each assignment names (`s = s.Table("labels")` names it later).
  const builders = spec.builderVars ? builderLocals(lines, spec) : null;
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!);
    if (!line.includes("(")) continue;
    if (spec.generic) for (const m of line.matchAll(spec.generic)) out.push(row(m[1]!, m[2]!, i + 1, null));
    if (spec.helper) for (const m of line.matchAll(spec.helper)) out.push(row(m[1] === "Insert" ? "Insert" : "Delete", entityOfArg(m[2]!, lines, i), i + 1, m[2]!));
    for (const m of line.matchAll(spec.terminal)) {
      // A verb opening its line continues the chain the line above ends with `.`.
      const continued = !m[0].trimStart().startsWith(".");
      if (continued && !(i > 0 && stripComment(lines[i - 1]!).trimEnd().endsWith("."))) continue;
      const chain = chainBefore(lines, i, m.index! + (continued ? m[0].search(/\S/) : 0));
      const held = builders ? builderModel(builders, /^([a-z_]\w*)(?:\.|$)/.exec(chain)?.[1], i) : undefined;
      if (held === undefined && !spec.root.test(chain) && !spec.builder.test(chain) && !(spec.session && sessionTyped(chain, lines, i, spec.session))) continue;
      // `db.Find[T](…)` above already took this one.
      if (spec === XORM && /^db$/.test(chain)) continue;
      const arg = firstArg(line.slice(m.index! + m[0].length));
      const modelArg = spec.model?.exec(chain)?.[1] ?? held ?? undefined;
      const entity = (modelArg ? entityOfArg(modelArg.trim(), lines, i) : null) ?? (arg ? entityOfArg(arg, lines, i) : null);
      out.push(row(m[1]!, entity, i + 1, arg));
    }
  }
  return out;
}

/**
 * The locals a function stores a chain in — `s := UnscopedDb().Table("albums").Select(…)`, then
 * `s = s.Where(…)` / `s = s.Table("labels")` — with the model each assignment names (null when none),
 * by the line it is made on. A local assigned anything else stops being one.
 */
type BuilderAssignment = { line: number; model: string | null; dead?: true };

function builderLocals(lines: string[], spec: OrmChainSpec): Map<string, BuilderAssignment[]> {
  const out = new Map<string, BuilderAssignment[]>();
  for (let i = 0; i < lines.length; i++) {
    // A function's locals are its own: every local dies where the next function starts.
    if (/^func\b/.test(lines[i]!)) {
      for (const list of out.values()) list.push({ line: i, model: null, dead: true });
      continue;
    }
    const m = /^\s*([a-z_]\w*)\s*:?=\s*(.+)$/.exec(stripComment(lines[i]!));
    if (!m) continue;
    let rhs = m[2]!.trim();
    for (let k = i + 1; k < lines.length && k < i + 12 && rhs.endsWith("."); k++) rhs += stripComment(lines[k]!).trim();
    const own = out.get(m[1]!);
    const chained = spec.root.test(rhs) || (own !== undefined && new RegExp(`^${m[1]}\\s*\\.`).test(rhs));
    if (!chained) {
      if (own) own.push({ line: i, model: null, dead: true });
      continue;
    }
    // A chain finished in its own statement is no builder (`err := Db().Create(&x).Error`).
    spec.terminal.lastIndex = 0;
    if (spec.terminal.test(rhs.replace(/^[^.]*\./, "."))) { spec.terminal.lastIndex = 0; continue; }
    spec.terminal.lastIndex = 0;
    const model = spec.model?.exec(rhs)?.[1]?.trim() ?? null;
    (own ?? out.set(m[1]!, []).get(m[1]!)!).push({ line: i, model });
  }
  return out;
}

/** The model a builder local holds at line `i` (the latest assignment above naming one), or undefined when it holds no chain. */
function builderModel(builders: Map<string, BuilderAssignment[]>, name: string | undefined, i: number): string | null | undefined {
  const list = name ? builders.get(name) : undefined;
  const before = list?.filter((b) => b.line < i);
  if (!before?.length || before[before.length - 1]!.dead) return undefined;
  for (let k = before.length - 1; k >= 0 && !before[k]!.dead; k--) if (before[k]!.model) return before[k]!.model;
  return null;
}

/** The chain's root variable is declared in the enclosing function as a type `session` matches. */
function sessionTyped(chain: string, lines: string[], i: number, session: RegExp): boolean {
  const root = /^([a-z_]\w*)(?:\.|$)/.exec(chain)?.[1];
  if (!root) return false;
  const decl = new RegExp(String.raw`(?:\(|,|\bvar)\s*${root}\s+(\*?[\w.]+)|\b${root}\s*:?=\s*(?:[\w.]+\.)?(?:NewSession|NewEngine)\(`);
  for (let j = i; j >= 0 && i - j < 200; j--) {
    const l = stripComment(lines[j]!);
    const m = decl.exec(l);
    if (m) return !m[1] || session.test(m[1]);
    if (/^func\b/.test(l)) break;
  }
  return false;
}

function stripComment(line: string): string {
  const i = line.indexOf("//");
  return i >= 0 ? line.slice(0, i) : line;
}

/**
 * The call chain the verb at (`i`, `col`) is called on, read backwards with
 * brackets balanced: `db.GetEngine(ctx).Where("…", id).` → that text, over lines
 * that end in `.`. Stops at the first character that cannot be part of it
 * (`=`, `,`, `(` of an enclosing call, a keyword's space).
 */
function chainBefore(lines: string[], i: number, col: number): string {
  let text = stripComment(lines[i]!).slice(0, col);
  for (let j = i - 1; j >= 0 && i - j < 8; j--) {
    const prev = stripComment(lines[j]!).trimEnd();
    if (!(prev.endsWith(".") || /^\s*$/.test(text))) break;
    if (!prev.endsWith(".") && /^\s*$/.test(text)) break;
    text = prev + text.trimStart();
  }
  text = text.replace(/\.\s*$/, "");
  let depth = 0;
  let k = text.length - 1;
  for (; k >= 0; k--) {
    const ch = text[k]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[\w.\s]/.test(ch)) break;
    else if (depth === 0 && /\s/.test(ch) && !/\.\s*$/.test(text.slice(0, k)) && !/^\s*\./.test(text.slice(k))) break;
  }
  return text.slice(k + 1).replace(/\s+/g, "");
}

/** The first argument's text: `&labels`, `issue`, `&Comment{`, `new(Issue)`. */
function firstArg(rest: string): string | null {
  // `new(Match)` before a bare name, which would stop at `new`.
  const m = /^\s*(new\(\s*[\w.]+\s*\)|&?[A-Za-z_][\w.]*\s*\{?)/.exec(rest);
  return m ? m[1]!.trim() : null;
}

/** The entity an argument names, through its declaration in the enclosing function when it is a variable. */
function entityOfArg(arg: string, lines: string[], i: number): string | null {
  // A table named outright: `.Table("issue")`.
  const table = /^"([\w.]+)"$/.exec(arg)?.[1];
  if (table) return table.split(".").pop()!;
  // A composite literal names its type, exported or not (a migration's own `&clubTokens20210711{…}`).
  const literal = /^&?(?:[a-z_]\w*\.)?([A-Za-z_]\w*)\s*\{/.exec(arg) ?? /^new\(\s*(?:[a-z_]\w*\.)?([A-Za-z_]\w*)\s*\)$/.exec(arg);
  if (literal) return literal[1]!;
  const name = /^&?([a-z_]\w*)$/.exec(arg)?.[1];
  if (!name) return null;
  for (let j = i; j >= 0 && i - j < 120; j--) {
    const l = stripComment(lines[j]!);
    const typed = declaredType(l, name);
    if (typed) return typed;
    if (/^func\b/.test(l)) break;
  }
  return null;
}

const TYPE = String.raw`(?:\[\]|\*|\[\]\*)*(?:[a-z_]\w*\.)?([A-Z]\w*)`;

/** `name`'s element type, when `line` declares it: a short or var declaration, or a parameter. */
function declaredType(line: string, name: string): string | null {
  const n = escapeRegex(name);
  const forms = [
    new RegExp(String.raw`\b${n}\s*:=\s*&?(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\{`),
    new RegExp(String.raw`\b${n}\s*:=\s*new\(\s*(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\)`),
    new RegExp(String.raw`\b${n}\s*:=\s*make\(\s*${TYPE}`),
    new RegExp(String.raw`\bvar\s+${n}\s+${TYPE}`),
    new RegExp(String.raw`[(,]\s*${n}\s+${TYPE}\s*[,)]`),
    // The method's receiver: \`func (m *Photo) Save()\`.
    new RegExp(String.raw`^func\s*\(\s*${n}\s+\*?(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\)`),
  ];
  for (const re of forms) {
    const m = re.exec(line);
    if (m) return m[1]!;
  }
  return null;
}
