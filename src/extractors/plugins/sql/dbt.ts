import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/**
 * dbt models: a `.sql` file of Jinja around one SELECT. The model is a table (or view) named by its file; it is built
 * from the models and sources it names:
 *
 *     {{ config(materialized='table') }}
 *     select c.id, t.total from {{ ref('stg_clubs') }} c join {{ source('raw', 'transfers') }} t on …
 *
 * The Jinja is replaced so the SQL reader sees plain SQL on the same lines — `ref('x')` is `x`, `source('a', 'b')` is
 * `a.b`, statements and comments are blanked — and the model joins the entity graph as a table built from them
 * (`implements`: its lineage, as a view's is), reading each upstream and writing itself.
 */

const REF_RE = /\{\{-?\s*ref\s*\(\s*(?:['"]([^'"]+)['"]\s*,\s*)?['"]([^'"]+)['"][^)]*\)\s*-?\}\}/g;
const SOURCE_RE = /\{\{-?\s*source\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*-?\}\}/g;
/** What an unknown Jinja expression stands for in the SQL: no table. */
const EXPR = "__dbt_expr__";

/** Is the file a dbt model: it names a model or a source, and is no macro, test or analysis. */
export function isDbtModel(rawSource: string, relativePath: string): boolean {
  if (!rawSource.includes("{{")) return false;
  if (/(?:^|\/)(?:macros|tests|analyses|target|dbt_packages|dbt_modules)\//.test(relativePath)) return false;
  return /\{\{-?\s*(?:ref|source)\s*\(/.test(rawSource) || (/\{\{-?\s*config\s*\(/.test(rawSource) && /(?:^|\/)models\//.test(relativePath));
}

/** The text with a pattern's matches replaced, every newline inside a match kept so lines stay where they were. */
function replaceKeepingLines(text: string, re: RegExp, to: (m: RegExpExecArray) => string): string {
  return text.replace(re, (...args) => {
    const m = args.slice(0, -2) as unknown as RegExpExecArray;
    const whole = m[0]!;
    return to(m) + whole.replace(/[^\n]/g, "");
  });
}

/** The SQL a model's Jinja stands for, line for line. */
export function dbtSql(raw: string, own: string): string {
  let text = raw;
  text = replaceKeepingLines(text, /\{#[\s\S]*?#\}/g, () => "");
  text = replaceKeepingLines(text, /\{%-?[\s\S]*?-?%\}/g, () => "");
  text = replaceKeepingLines(text, REF_RE, (m) => m[2]!);
  text = replaceKeepingLines(text, SOURCE_RE, (m) => `${m[1]}.${m[2]}`);
  text = replaceKeepingLines(text, /\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}/g, () => "");
  text = replaceKeepingLines(text, /\{\{-?\s*this\s*-?\}\}/g, () => own);
  text = replaceKeepingLines(text, /\{\{[\s\S]*?\}\}/g, () => EXPR);
  return text;
}

const stemOf = (path: string): string => path.split("/").pop()!.replace(/\.[^.]+$/, "");

/** The model a dbt file defines, as the SQL plugin's preprocess outcome; null for any other file. */
export function dbtPreprocess(rawSource: string, relativePath: string): PreprocessOutcome | null {
  if (!isDbtModel(rawSource, relativePath)) return null;
  const alias = /\{\{-?\s*config\s*\([^)]*\balias\s*=\s*['"]([^'"]+)['"]/.exec(rawSource)?.[1];
  const name = alias ?? stemOf(relativePath);
  const upstream: string[] = [];
  for (const m of rawSource.matchAll(REF_RE)) if (!upstream.includes(m[2]!)) upstream.push(m[2]!);
  for (const m of rawSource.matchAll(SOURCE_RE)) {
    const table = `${m[1]}.${m[2]}`;
    if (!upstream.includes(table)) upstream.push(table);
  }
  return {
    sourceText: dbtSql(rawSource, name),
    language: "sql",
    postExtract(analysis: FileAnalysis): void {
      analysis.dataSources = analysis.dataSources.filter((d) => !d.target?.includes(EXPR) && !d.entity?.includes(EXPR));
      const lines = rawSource.split("\n").length;
      const model: ClassInfo = {
        name,
        extends: null,
        implements: upstream,
        decorators: ["table", "dbt"],
        methods: [],
        properties: [],
        isExported: true,
        line: 1,
        endLine: lines,
      };
      analysis.classes.push(model);
      // The model builds its table.
      analysis.dataSources.push({ kind: "database", name: "dbt model", target: name, entity: name, access: "write", calls: [], line: 1 });
    },
  };
}
