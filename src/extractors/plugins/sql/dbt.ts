import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { byOrdinal } from "../../../core/ordinal.js";
import type { ClassInfo, FileAnalysis, PropertyInfo } from "../../../types/analysis.js";
import type { PreprocessContext, PreprocessOutcome } from "../../../types/language-plugin.js";

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

const NOT_A_MODEL_DIR = /(?:^|\/)(?:macros|tests|analyses|target|dbt_packages|dbt_modules)\//;

/** A dbt project: the directory holding `dbt_project.yml`, its model directories and the columns its YAMLs declare. */
export interface DbtProject {
  root: string;
  modelPaths: string[];
  /** Model name → the columns a properties file (`schema.yml`) lists for it. */
  columns: Map<string, PropertyInfo[]>;
  /** A fingerprint of the project file and every properties file read. */
  stamp: string;
}

/** The properties-file reader: `models: - name: x  columns: - name: id  data_type: int`, indentation-structured. */
export function parseDbtProperties(text: string): Map<string, PropertyInfo[]> {
  const out = new Map<string, PropertyInfo[]>();
  let inModels = false;
  let model: PropertyInfo[] | null = null;
  let modelIndent = -1;
  let inColumns = false;
  let columnsIndent = -1;
  let column: PropertyInfo | null = null;
  let columnIndent = -1;
  const unquote = (v: string) => v.trim().replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
  for (const raw of text.split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inModels = /^models\s*:/.test(line);
      model = null; inColumns = false; column = null;
      continue;
    }
    if (!inModels) continue;
    const item = /^-\s*name\s*:\s*(.+)$/.exec(line);
    if (item && (model === null || indent <= modelIndent)) {
      model = [];
      modelIndent = indent;
      inColumns = false; column = null;
      out.set(unquote(item[1]!), model);
      continue;
    }
    if (!model) continue;
    if (indent > modelIndent && /^columns\s*:/.test(line)) { inColumns = true; columnsIndent = indent; column = null; continue; }
    if (inColumns && indent <= columnsIndent) { inColumns = false; column = null; }
    if (!inColumns) continue;
    const col = /^-\s*name\s*:\s*(.+)$/.exec(line);
    if (col && (column === null || indent <= columnIndent)) {
      column = { name: unquote(col[1]!), type: null, visibility: "public", isStatic: false, isReadonly: false };
      columnIndent = indent;
      model.push(column);
      continue;
    }
    const dataType = column && indent > columnIndent ? /^data_type\s*:\s*(.+)$/.exec(line) : null;
    if (dataType) column!.type = unquote(dataType[1]!).toUpperCase();
  }
  return out;
}

const PROJECTS = new Map<string, { at: number; project: DbtProject }>();
/** A project read again after this long: an edit made while one process lives is seen. */
const PROJECT_TTL_MS = 2000;

function yamlFilesUnder(dir: string, depth = 0): string[] {
  if (depth > 8) return [];
  const found: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries.sort((a, b) => byOrdinal(a.name, b.name))) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!/^(?:target|dbt_packages|dbt_modules|node_modules|\.git)$/.test(e.name)) found.push(...yamlFilesUnder(join(dir, e.name), depth + 1)); }
    else if (/\.ya?ml$/.test(e.name)) found.push(join(dir, e.name));
  }
  return found;
}

function readDbtProject(root: string): DbtProject {
  const hit = PROJECTS.get(root);
  if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.project;
  const hash = createHash("sha256");
  let projectFile = "";
  try { projectFile = readFileSync(join(root, "dbt_project.yml"), "utf-8"); } catch { /* unreadable: defaults */ }
  hash.update(projectFile);
  const paths = /^(?:model-paths|source-paths)\s*:\s*(?:\[([^\]]*)\]|((?:\n\s+-\s*.+)+))/m.exec(projectFile);
  const listed = paths ? (paths[1] ?? paths[2]!.replace(/\n\s+-\s*/g, ",")).split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
  const modelPaths = listed.length ? listed : ["models"];
  const columns = new Map<string, PropertyInfo[]>();
  for (const mp of modelPaths) {
    for (const file of yamlFilesUnder(join(root, mp))) {
      let text: string;
      try { text = readFileSync(file, "utf-8"); } catch { continue; }
      if (!/^models\s*:/m.test(text)) continue;
      hash.update(relative(root, file)).update(text);
      for (const [name, cols] of parseDbtProperties(text)) if (!columns.has(name) || columns.get(name)!.length === 0) columns.set(name, cols);
    }
  }
  const project: DbtProject = { root, modelPaths, columns, stamp: hash.digest("hex").slice(0, 16) };
  PROJECTS.set(root, { at: Date.now(), project });
  return project;
}

/** The dbt project a file belongs to: the nearest directory, up to the analysis root, holding `dbt_project.yml`. */
export function dbtProjectOf(absolutePath: string, projectRoot: string): DbtProject | null {
  const top = resolve(projectRoot);
  let dir = resolve(dirname(absolutePath));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, "dbt_project.yml"))) return readDbtProject(dir);
    if (dir === top || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
  return null;
}

/** Whether a file sits in one of the project's model directories (and in no macro, test or analysis folder). */
function inModelPaths(project: DbtProject, absolutePath: string): boolean {
  const rel = relative(project.root, resolve(absolutePath)).split(sep).join("/");
  return !rel.startsWith("..") && !NOT_A_MODEL_DIR.test(rel) && project.modelPaths.some((mp) => rel.startsWith(mp.replace(/^\.\//, "").replace(/\/$/, "") + "/"));
}

/** What the model's preprocess reads beside the file, for the incremental cache. */
export function dbtStamp(absolutePath: string, projectRoot: string): string | undefined {
  return dbtProjectOf(absolutePath, projectRoot)?.stamp;
}

/**
 * Is the file a dbt model: it names a model or a source, or sits in the model directory of a dbt project
 * (`dbt_project.yml` at its root) — and is no macro, test or analysis.
 */
export function isDbtModel(rawSource: string, relativePath: string, project?: DbtProject | null, absolutePath?: string): boolean {
  if (NOT_A_MODEL_DIR.test(relativePath)) return false;
  if (project && absolutePath && inModelPaths(project, absolutePath)) return true;
  if (!rawSource.includes("{{")) return false;
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
export function dbtPreprocess(rawSource: string, relativePath: string, context?: PreprocessContext): PreprocessOutcome | null {
  const project = context ? dbtProjectOf(context.absolutePath, context.projectRoot) : null;
  if (!isDbtModel(rawSource, relativePath, project, context?.absolutePath)) return null;
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
        properties: (project?.columns.get(name) ?? []).map((c) => ({ ...c })),
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
