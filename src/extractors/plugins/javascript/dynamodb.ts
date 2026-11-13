import type { Node } from "web-tree-sitter";
import { literalString, stripQuotes } from "../../shared/node-helpers.js";

/**
 * A DynamoDB table access: SDK v2's DocumentClient (`docClient.get({ TableName, Key }).promise()`),
 * v3's `lib-dynamodb` / `client-dynamodb` commands (`ddb.send(new GetCommand({ TableName }))`).
 * The table is the literal the request states, or the environment variable it reads
 * (`TableName: process.env.CLUBS_TABLE`, directly or through a constant the file declares with it) —
 * which a deployment descriptor sets (`DataSourceInfo.envRef`; the serverless plugin joins it).
 */
export interface DynamoAccess {
  name: string;
  access: "read" | "write";
  /** The table as a literal. */
  table?: string;
  /** The environment variable holding the table name. */
  env?: string;
}

/** Files that can hold one: a DynamoDB client or the v2 SDK that has it. */
export const DYNAMO_FILE_RE = /dynamodb|aws-sdk/i;

const OPS = new Map<string, "read" | "write">([
  ["get", "read"], ["query", "read"], ["scan", "read"],
  ["put", "write"], ["update", "write"], ["delete", "write"],
]);
const COMMANDS = /^(Get|Put|Update|Delete|Query|Scan)(?:Item)?Command$/;

const ENV_RE = /^process\.env\.([A-Za-z_]\w*)\s*(?:!|\s+as\s+string)?$|^process\.env\[['"]([^'"]+)['"]\]\s*(?:!|\s+as\s+string)?$/;

/** What a `TableName` value names: a literal, an env read, or a constant of the file holding either. */
function tableOf(value: Node | null, source: string): Pick<DynamoAccess, "table" | "env"> | null {
  if (!value) return null;
  const lit = literalString(value);
  if (lit) return { table: lit };
  const env = ENV_RE.exec(value.text.trim());
  if (env) return { env: env[1] ?? env[2]! };
  if (value.type === "identifier") {
    const raw = value.text;
    const name = raw.replace(/[$]/g, "\\$&");
    // One declaration only: the scan is not scope-aware, so a name declared twice names nothing.
    const decls = [...source.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`, "g"))];
    const decl = decls.length === 1 ? decls[0]![1]!.trim() : undefined;
    if (decl) {
      const s = /^(['"])([^'"\n]*)\1$/.exec(decl);
      if (s) return { table: s[2]! };
      const e = ENV_RE.exec(decl);
      if (e) return { env: e[1] ?? e[2]! };
    }
    if (new RegExp(`(?:const|let|var)\\s*\\{[^}:]*\\b${name}\\b[^}:]*\\}\\s*=\\s*process\\.env\\b`).test(source)) return { env: raw };
  }
  return null;
}

/** The request object a call hands over: an object literal, or an identifier a statement above declares as one. */
function requestObject(arg: Node | undefined): Node | null {
  if (!arg) return null;
  if (arg.type === "object") return arg;
  if (arg.type !== "identifier") return null;
  for (let p: Node | null = arg.parent; p; p = p.parent) {
    if (p.type !== "statement_block" && p.type !== "program") continue;
    for (const st of p.namedChildren) {
      const decl = st.type === "lexical_declaration" || st.type === "variable_declaration" ? st : st.type === "export_statement" ? st.namedChildren[0] : null;
      for (const d of decl?.namedChildren ?? []) {
        const v = d.type === "variable_declarator" && d.childForFieldName("name")?.text === arg.text ? d.childForFieldName("value") : null;
        if (v?.type === "object") return v;
      }
    }
  }
  return null;
}

function tableNameValue(obj: Node): Node | null {
  for (const pair of obj.children) {
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (k && (k.type === "string" ? stripQuotes(k.text) : k.text) === "TableName") return pair.childForFieldName("value");
  }
  return null;
}

export function dynamoAccess(node: Node, source: string): DynamoAccess | null {
  let verb: string;
  let label: string;
  let arg: Node | undefined;
  if (node.type === "new_expression") {
    const ctor = node.childForFieldName("constructor")?.text ?? "";
    const m = COMMANDS.exec(ctor);
    if (!m) return null;
    verb = m[1]!.toLowerCase();
    label = ctor;
    arg = node.childForFieldName("arguments")?.namedChildren[0];
  } else if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    const prop = fn?.type === "member_expression" ? fn.childForFieldName("property") : null;
    if (!prop || !OPS.has(prop.text)) return null;
    verb = prop.text;
    label = prop.text;
    arg = node.childForFieldName("arguments")?.namedChildren[0];
  } else return null;
  const obj = requestObject(arg);
  const table = obj ? tableOf(tableNameValue(obj), source) : null;
  if (!table) return null;
  return { name: `DynamoDB: ${label}`, access: OPS.get(verb)!, ...table };
}
