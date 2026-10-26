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

/** `scope :active, -> { … }` → a class method `active` spanning the scope's lines. */
export function addScopeMethods(lines: readonly string[], cls: ClassInfo): void {
  if (!isModelClass(cls)) return;
  const have = new Set(cls.methods.map((m) => m.name));
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const m = SCOPE_RE.exec(lines[i] ?? "");
    if (!m || have.has(m[2]!)) continue;
    have.add(m[2]!);
    const end = statementEnd(lines, i, m[1]!, Math.min(cls.endLine, lines.length) - 1);
    cls.methods.push({
      name: m[2]!,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: true,
      decorators: ["scope"],
      calls: [],
      line: i + 1,
      endLine: end + 1,
    });
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
