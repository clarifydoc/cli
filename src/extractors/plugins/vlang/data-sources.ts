import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { vSqlLines } from "./source.js";

/**
 * V data access:
 *
 *  - the built-in ORM: `sql db { select from User where id == 1 }` reads the
 *    `User` table, `insert u into User` / `upsert`, `update User set …` and
 *    `delete from User where …` write it; `create table` / `drop table` are
 *    schema changes. The entity is the struct (`entity.Package` → `Package`).
 *    A block may hold several statements and span lines, or sit inside an
 *    expression on one line.
 *  - `net.http`: `http.get('https://…')`, `http.post_json(url, body)`,
 *    `http.fetch(url: '…', method: .post)`, …
 *
 * SQL in strings (`db.exec('SELECT …')`) is read from the raw source by
 * `extractVSqlSources`.
 */
export function extractVDataSources(lines: string[]): DataSourceInfo[] {
  return [...ormStatements(lines), ...httpCalls(lines)].sort((a, b) => a.line - b.line);
}

const ORM_STATEMENTS: ReadonlyArray<[RegExp, string, DataSourceInfo["access"] | null]> = [
  [/\bselect\s+(?:count\s+)?from\s+([A-Za-z_][\w.]*)/g, "select", "read"],
  [/\b(?:insert|upsert)\s+[A-Za-z_][\w.]*\s+into\s+([A-Za-z_][\w.]*)/g, "insert", "write"],
  [/\bupdate\s+([A-Za-z_][\w.]*)\s+set\b/g, "update", "write"],
  [/\bdelete\s+from\s+([A-Za-z_][\w.]*)/g, "delete", "write"],
  [/\bcreate\s+table\s+([A-Za-z_][\w.]*)/g, "create table", null],
  [/\bdrop\s+table\s+([A-Za-z_][\w.]*)/g, "drop table", null],
];

function ormStatements(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /\bsql\s+[A-Za-z_][\w.]*\s*\{/.exec(lines[i]!);
    if (!open) continue;
    // The block, from its `{` to the matching `}`, possibly on later lines.
    let depth = 0;
    let j = i;
    let col = open.index + open[0].length - 1;
    done: for (; j < lines.length; j++, col = 0) {
      const line = lines[j]!;
      for (let k = col; k < line.length; k++) {
        if (line[k] === "{") depth++;
        else if (line[k] === "}" && --depth === 0) {
          scan(line.slice(j === i ? open.index + open[0].length : 0, k), j);
          break done;
        }
      }
      scan(line.slice(j === i ? open.index + open[0].length : 0), j);
    }
    i = Math.max(i, j);
  }
  function scan(text: string, line: number): void {
    for (const [re, verb, access] of ORM_STATEMENTS) {
      for (const m of text.matchAll(re)) {
        const entity = m[1]!.split(".").pop()!;
        const ds: DataSourceInfo = { kind: "database", name: `${verb} ${entity}`, target: entity, entity, calls: [], line: line + 1 };
        if (access) ds.access = access;
        out.push(ds);
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const HTTP_VERB: Record<string, string> = {
  get: "GET", get_text: "GET", head: "HEAD", delete: "DELETE", put: "PUT", patch: "PATCH",
  post: "POST", post_json: "POST", post_form: "POST", post_multipart_form: "POST",
};

function httpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, target: string, line: number) => {
    if (!target.startsWith("/") && !/^https?:\/\//i.test(target)) return;
    out.push({ kind: "api-call", name: `${method} ${target}`, target: target.replace(/\$\{\s*([\w.]+?)\s*\}/g, (_m, v: string) => `{${v.split(".").pop()}}`), calls: [], line });
  };
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/\bhttp\.(\w+)\s*\(\s*(['"])([^'"]+)\2/g)) {
      const method = HTTP_VERB[m[1]!];
      if (method) push(method, m[3]!, i + 1);
    }
    for (const m of line.matchAll(/\bhttp\.fetch\s*\(([^)]*)/g)) {
      const url = /\burl\s*:\s*(['"])([^'"]+)\1/.exec(m[1]!)?.[2];
      if (url) push((/\bmethod\s*:\s*\.(\w+)/.exec(m[1]!)?.[1] ?? "get").toUpperCase(), url, i + 1);
    }
  });
  return out;
}

/** SQL statements in the file's strings (raw source). */
export function extractVSqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(vSqlLines(rawLines));
}
