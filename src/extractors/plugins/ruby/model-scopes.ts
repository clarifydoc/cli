import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * Inside an ActiveRecord model the receiver of a query is the model itself:
 * `scope :active, -> { where(active: true) }`, `def self.search(q) where(…)`,
 * `update!(status: :closed)` in an instance method. The per-line chain
 * patterns need a written receiver, so these read and write nothing there.
 * A scope is also a class method the model gains — `Club.active` calls it —
 * so it is recorded as one, and its query is that method's row.
 */

/** A model class: it extends the application's record base or ActiveRecord's. */
export function isModelClass(cls: ClassInfo): boolean {
  return !!cls.extends && /(?:^|::)(?:ApplicationRecord|ActiveRecord::Base)$/.test(cls.extends);
}

const SCOPE_RE = /^(\s*)scope\s+:([a-z_]\w*[?!]?)\s*,/;

/** The last line of a statement opened at `from`: its braces (or `do … end` at the same indent) closed. */
function statementEnd(lines: readonly string[], from: number, indent: string, limit: number): number {
  const first = (lines[from] ?? "").replace(/\s#.*$/, "");
  if (/\bdo\s*(\|[^|]*\|)?\s*$/.test(first)) {
    for (let j = from + 1; j <= limit; j++) if (new RegExp(`^${indent}end\\b`).test(lines[j] ?? "")) return j;
    return from;
  }
  let depth = 0;
  for (let j = from; j <= limit; j++) {
    const code = (lines[j] ?? "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\s#.*$/, "");
    for (const ch of code) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (depth <= 0) return j;
  }
  return from;
}

const MEMBER_MACRO_RE = /^\s*(?:has_one|has_many|belongs_to|has_and_belongs_to_many|has_one_attached|has_many_attached|has_rich_text|attribute|attr_accessor|attr_reader|store_accessor)\s+((?::[a-z_]\w*\s*,?\s*)+)/;
const ENUM_RE = /^\s*enum\s+(?::([a-z_]\w*)\s*,|([a-z_]\w*):(?!:))\s*/;

/**
 * The scopes an `enum` declares — one per value, named as Rails names them:
 *   enum :provider, { field: 0, remote: 1 }        → field, remote
 *   enum status: %i[open closed], _prefix: true   → status_open, status_closed
 *   enum role: [:coach, :player], suffix: :role    → coach_role, player_role
 * None for values the source computes (`enum kind: KINDS`) or `scopes: false`.
 */
export function enumScopes(text: string): string[] {
  const head = ENUM_RE.exec(text);
  if (!head) return [];
  const attr = head[1] ?? head[2]!;
  const rest = text.slice(head[0].length);
  const open = /^(?:%[wi])?([{[])/.exec(rest);
  if (!open) return [];
  const close = open[1] === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = open[0].length - 1; i < rest.length; i++) {
    if (rest[i] === open[1]) depth++;
    else if (rest[i] === close && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const body = rest.slice(open[0].length, end);
  const options = rest.slice(end + 1);
  if (/\bscopes:\s*false\b/.test(options)) return [];
  const values = open[0].startsWith("%")
    ? body.split(/\s+/).filter(Boolean)
    : open[1] === "{"
      ? [...body.matchAll(/(?:^|[{,\s]):?([a-z_]\w*)(?::(?!:)|\s*=>)/g)].map((m) => m[1]!)
      : [...body.matchAll(/:([a-z_]\w*)/g)].map((m) => m[1]!);
  const affix = (key: string): string | null => {
    const m = new RegExp(String.raw`\b_?${key}:\s*(true|:([a-z_]\w*)|["']([a-z_]\w*)["'])`).exec(options);
    return m ? (m[1] === "true" ? attr : m[2] ?? m[3]!) : null;
  };
  const prefix = affix("prefix");
  const suffix = affix("suffix");
  return values.filter((v) => /^[a-z_]\w*$/.test(v)).map((v) => `${prefix ? `${prefix}_` : ""}${v}${suffix ? `_${suffix}` : ""}`);
}

/**
 * `scope :active, -> { … }` → a class method `active` spanning the scope's
 * lines; an `enum`'s values → a scope each (`Club.field`), on the enum's line.
 */
export function addScopeMethods(lines: readonly string[], cls: ClassInfo): void {
  if (!isModelClass(cls)) return;
  const have = new Set(cls.methods.map((m) => m.name));
  const add = (name: string, line: number, endLine: number) => {
    have.add(name);
    cls.methods.push({ name, params: [], returnType: null, isAsync: false, isExported: true, decorators: ["scope"], calls: [], line, endLine });
  };
  const last = Math.min(cls.endLine, lines.length) - 1;
  // What an instance answers to by the macros that declare it (`has_one_attached :kit`, `belongs_to :club`):
  // a bare `kit` in the model reads that, never an enum value's scope of the same name.
  const members = new Set<string>();
  for (let i = cls.line; i <= last; i++) {
    const m = MEMBER_MACRO_RE.exec(lines[i] ?? "");
    if (m) for (const n of m[1]!.matchAll(/:([a-z_]\w*)/g)) members.add(n[1]!);
  }
  for (let i = cls.line; i <= last; i++) {
    const m = SCOPE_RE.exec(lines[i] ?? "");
    if (m) {
      if (!have.has(m[2]!)) add(m[2]!, i + 1, statementEnd(lines, i, m[1]!, last) + 1);
      continue;
    }
    if (!ENUM_RE.test(lines[i] ?? "")) continue;
    // The statement, over the lines its brackets span.
    let text = (lines[i] ?? "").replace(/\s#.*$/, "");
    let j = i;
    const open = (t: string) => [...t].reduce((d, ch) => d + ("{[(".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0), 0);
    while (open(text) > 0 && j < last && j - i < 30) text += " " + (lines[++j] ?? "").replace(/\s#.*$/, "");
    for (const name of enumScopes(text)) if (!have.has(name) && !members.has(name)) add(name, i + 1, j + 1);
  }
}

const READS = ["where", "find_by", "find_by!", "find", "find_each", "includes", "joins", "left_joins", "order", "select", "pluck", "exists?", "group", "having", "distinct", "limit", "unscoped", "find_or_create_by", "find_or_create_by!", "find_or_initialize_by"];
const WRITES = ["create", "create!", "update", "update!", "update_all", "update_columns", "update_column", "destroy_all", "delete_all", "insert_all", "upsert_all", "increment!", "decrement!", "toggle!"];
const WRITE_SET = new Set(WRITES);
const verbAlt = [...READS, ...WRITES].map(escapeRegex).join("|");
/** A bare verb with its argument list, or `self.verb(`: the model is the receiver. */
const BARE_VERB_RE = new RegExp(`(?<![\\w.@$:])(?:self\\.)?(${verbAlt})(?=\\s*\\()`, "g");
/** A statement that only persists the record itself: `save!`, `self.destroy`. */
const SELF_SAVE_RE = /^\s*(?:self\.)?(save!?|destroy!?|touch)\s*(?:$|\bif\b|\bunless\b)/;

/** The reads and writes a model makes on itself, as rows of that model. */
export function extractModelSelfQueries(lines: readonly string[], classes: readonly ClassInfo[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (const cls of classes) {
    if (!isModelClass(cls)) continue;
    const entity = cls.name.split("::").pop()!;
    for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
      const raw = lines[i] ?? "";
      if (/^\s*(?:#|def\b|alias\b)/.test(raw)) continue;
      const code = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\s#.*$/, "");
      const seen = new Set<string>();
      const push = (verb: string) => {
        if (seen.has(verb)) return;
        seen.add(verb);
        out.push({ kind: "database", name: `${cls.name}.${verb}`, target: null, calls: [], line: i + 1, entity, access: WRITE_SET.has(verb) || /^(?:save|destroy|touch)/.test(verb) ? "write" : "read" });
      };
      for (const m of code.matchAll(BARE_VERB_RE)) push(m[1]!);
      const save = SELF_SAVE_RE.exec(code);
      if (save) push(save[1]!);
    }
  }
  return out;
}
