import type { DataSourceInfo } from "../../../types/analysis.js";

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
}

const XORM: OrmChainSpec = {
  label: "xorm",
  file: /xorm\.io\/|\bdb\.GetEngine\(|\.NewSession\(\)|\bdb\.(?:Find|Get|GetByID|Count|Exist|Insert|DeleteByID|DeleteBeans)\b/,
  terminal: /(?:\.\s*|^\s*)(Find|FindAndCount|Get|Exist|Count|Iterate|Sum|SumInt|Sums|Insert|InsertOne|Update|Delete|Incr|Decr)\s*\(/g,
  builder: /\.\s*(?:Where|And|Or|ID|In|NotIn|Table|Cols|MustCols|AllCols|Select|OrderBy|Desc|Asc|Limit|Join|GroupBy|Having|Distinct|Omit|NoAutoCondition|Unscoped)\s*\(/,
  root: /^(?:db\.GetEngine\(|(?:e|x|sess|session|engine|dbEngine|ss)(?:\.|$))/,
  reads: new Set(["Find", "FindAndCount", "Get", "GetByID", "Exist", "Count", "Iterate", "Sum", "SumInt", "Sums"]),
  generic: /\bdb\.(Find|Get|GetByID|Count|Exist|DeleteByID|FindAndCount)\s*\[\s*(?:\*?[A-Za-z_]\w*\.)?\*?([A-Z]\w*)\s*\]\s*\(/g,
  helper: /\bdb\.(Insert|DeleteBeans|TruncateBeans)\s*\(\s*ctx\s*,\s*(&?[A-Za-z_][\w.]*(?:\{)?|new\(\s*[\w.]+\s*\))/g,
};

/**
 * GORM chains (photoprism): `UnscopedDb().Model(m).UpdateColumn(…)`,
 * `Db().Where("photo_id = ?", id).Delete(&PhotoLabel{})`. A receiver directly
 * named like a DB (`db.Find(&x)`) is the per-line GORM rule's; this one reads
 * the chains it cannot, and takes the entity from a `.Model(…)` step first.
 */
const GORM: OrmChainSpec = {
  label: "GORM",
  file: /gorm\.io\/gorm|jinzhu\/gorm|\*gorm\.DB\b/,
  terminal: /(?:\.\s*|^\s*)(Find|First|Take|Last|Create|Save|Update|Updates|UpdateColumn|UpdateColumns|Delete|Count|Pluck|Scan|FirstOrCreate|FirstOrInit)\s*\(/g,
  builder: /\.\s*(?:Where|Not|Or|Model|Table|Select|Omit|Order|Limit|Offset|Group|Having|Joins|Preload|Unscoped|Debug|Session|WithContext|Distinct|Clauses)\s*\(/,
  root: /^(?:[A-Za-z_]\w*\.)?\w*(?:db|Db|DB|tx|Tx|orm|conn)\w*(?:\(\))?(?:\.|$)/,
  reads: new Set(["Find", "First", "Take", "Last", "Count", "Pluck", "Scan"]),
  model: /\.\s*Model\s*\(\s*(&?[A-Za-z_][\w.]*\s*\{?|new\(\s*[\w.]+\s*\))/,
};

export function extractXormDataSources(lines: string[]): DataSourceInfo[] {
  const gorm = extractOrmChains(lines, GORM);
  // A GORM file's `db.Insert`/`Unscoped()` are GORM's, not xorm's.
  return GORM.file.test(lines.join("\n")) ? gorm : [...extractOrmChains(lines, XORM), ...gorm];
}

function extractOrmChains(lines: string[], spec: OrmChainSpec): DataSourceInfo[] {
  if (!spec.file.test(lines.join("\n"))) return [];
  const out: DataSourceInfo[] = [];
  const READS = spec.reads;
  const row = (verb: string, entity: string | null, lineNo: number, target: string | null): DataSourceInfo => ({
    kind: "database",
    name: `${spec.label}: ${verb}`,
    target: entity ?? target,
    ...(entity ? { entity } : {}),
    access: READS.has(verb) ? "read" : "write",
    calls: [],
    line: lineNo,
  });
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
      if (!spec.root.test(chain) && !spec.builder.test(chain)) continue;
      // `db.Find[T](…)` above already took this one.
      if (spec === XORM && /^db$/.test(chain)) continue;
      const arg = firstArg(line.slice(m.index! + m[0].length));
      const modelArg = spec.model?.exec(chain)?.[1];
      const entity = (modelArg ? entityOfArg(modelArg.trim(), lines, i) : null) ?? (arg ? entityOfArg(arg, lines, i) : null);
      out.push(row(m[1]!, entity, i + 1, arg));
    }
  }
  return out;
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
  const m = /^\s*(&?[A-Za-z_][\w.]*\s*\{?|new\(\s*[\w.]+\s*\))/.exec(rest);
  return m ? m[1]!.trim() : null;
}

/** The entity an argument names, through its declaration in the enclosing function when it is a variable. */
function entityOfArg(arg: string, lines: string[], i: number): string | null {
  const literal = /^&?(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\{/.exec(arg) ?? /^new\(\s*(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\)$/.exec(arg);
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
  const n = name.replace(/[$]/g, "\\$&");
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
