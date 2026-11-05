/**
 * Supabase's generated database types (`supabase gen types typescript`):
 *
 *   export type Database = { public: { Tables: { clubs: { Row: {…}; Insert: {…}; Update: {…}; Relationships: […] } } } }
 *
 * Each table under a `Tables` map is an entity named by its table (what `supabase.from('clubs')` names), its `Row`
 * members the columns and each `Relationships` entry a foreign key to `referencedRelation`.
 */

export interface SupabaseTable {
  name: string;
  /** 1-based line of the table's key. */
  line: number;
  columns: Array<{ name: string; type: string }>;
  foreignKeys: Array<{ column: string; table: string }>;
}

function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return pairs[text[open]!] === ch ? i : -1;
    }
  }
  return -1;
}

/** The members of an object type's body: `[name, startIndex, valueText]` at depth 0. */
function members(body: string, base: number): Array<{ key: string; at: number; value: string }> {
  const out: Array<{ key: string; at: number; value: string }> = [];
  const re = /(?:^|[;,\n{])\s*["']?([A-Za-z_$][\w$]*)["']?\??\s*:\s*/g;
  let i = 0;
  while (i < body.length) {
    re.lastIndex = i;
    const m = re.exec(body);
    if (!m) break;
    const valueStart = m.index + m[0].length;
    // Value runs to the next top-level `;`, `,` or newline outside brackets/strings.
    let depth = 0;
    let quote = "";
    let j = valueStart;
    for (; j < body.length; j++) {
      const ch = body[j]!;
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
      else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) {
        // A type continued on the next line (`| null`) keeps going.
        if (ch === "\n" && /^\s*[|&]/.test(body.slice(j + 1, j + 40))) continue;
        break;
      }
    }
    const keyAt = m.index + m[0].indexOf(m[1]!);
    out.push({ key: m[1]!, at: base + keyAt, value: body.slice(valueStart, j).trim() });
    i = Math.max(j, i + 1);
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The tables of every `Tables: { … }` map in a generated types file. Empty when the file is not one. */
export function readSupabaseTables(source: string): SupabaseTable[] {
  if (!/\bTables\s*:\s*\{/.test(source) || !/\bRow\s*:\s*\{/.test(source)) return [];
  const out: SupabaseTable[] = [];
  const seen = new Set<string>();
  const tablesRe = /\bTables\s*:\s*\{/g;
  for (let m = tablesRe.exec(source); m; m = tablesRe.exec(source)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(source, open);
    if (close < 0) continue;
    for (const t of members(source.slice(open + 1, close), open + 1)) {
      if (!t.value.startsWith("{")) continue;
      const body = t.value.slice(1, t.value.lastIndexOf("}"));
      const parts = members(body, 0);
      const row = parts.find((p) => p.key === "Row");
      if (!row || !row.value.startsWith("{")) continue;
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      const columns = members(row.value.slice(1, row.value.lastIndexOf("}")), 0).map((c) => ({
        name: c.key,
        type: c.value.replace(/\s+/g, " "),
      }));
      const foreignKeys: SupabaseTable["foreignKeys"] = [];
      const rel = parts.find((p) => p.key === "Relationships");
      if (rel && rel.value.startsWith("[")) {
        for (const obj of rel.value.match(/\{[^{}]*\}/g) ?? []) {
          const table = /\breferencedRelation\s*:\s*["'`]([^"'`]+)["'`]/.exec(obj)?.[1];
          const column = /\bcolumns\s*:\s*\[\s*["'`]([^"'`]+)["'`]/.exec(obj)?.[1];
          if (table && column) foreignKeys.push({ column, table });
        }
      }
      out.push({ name: t.key, line: lineOf(source, t.at), columns, foreignKeys });
    }
  }
  return out;
}
