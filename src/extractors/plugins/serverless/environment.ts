import type { RouteFact } from "../../../types/analysis.js";
import { parseOpenApiDocument, type SpecNode } from "../openapi/index.js";

/**
 * The environment a descriptor gives its functions, as literal values:
 *
 *   provider: { environment: { CLUBS_TABLE: "${self:service}-clubs" } }     # every function
 *   functions: { list: { handler: …, environment: { … } } }                 # one function (wins)
 *   Globals: { Function: { Environment: { Variables: { … } } } }            # SAM, every function
 *   CLUBS_TABLE: !Ref ClubsTable                                            # the table resource's `TableName`, else its logical id
 *
 * A value is kept only when everything in it is stated by the file: `${self:…}` read from the same
 * document, a `Ref` to a DynamoDB table resource. `${opt:stage}`, `${ssm:…}`, `!Sub` pseudo parameters
 * and a `Ref` to a parameter leave the variable out — a table is never guessed. One `lambda-env` fact
 * per scope; `handler` is null for the descriptor-wide one. The project pass (`route-anchor.ts`) puts
 * each on the code it runs.
 */
export interface LambdaEnv {
  handler: string | null;
  env: Record<string, string>;
}

const childOf = (n: SpecNode | undefined, key: string): SpecNode | undefined => n?.children.get(key);
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

const TABLE_TYPES = new Set(["AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable", "AWS::Serverless::SimpleTable"]);

/** A `${self:a.b}` hole read from the same document; null when anything in the text is set at deploy time. */
function fill(text: string, root: SpecNode, depth: number): string | null {
  if (depth > 4) return null;
  let failed = false;
  const out = text.replace(/\$\{self:([\w.-]+)\}/g, (_h, path: string) => {
    let node: SpecNode | undefined = root;
    for (const key of path.split(".")) node = childOf(node, key);
    // `service: { name: clubs }` is the framework's long form of `service: clubs`.
    const v = node?.value ?? childOf(node, "name")?.value ?? null;
    const filled = v === null ? null : fill(unquote(v), root, depth + 1);
    if (filled === null) failed = true;
    return filled ?? "";
  });
  return failed || out.includes("${") || out.length === 0 ? null : out;
}

/** A `Ref` to a table resource: its `TableName` when it states one, else the logical id (what the stack names it). */
function tableOfRef(name: string, root: SpecNode): string | null {
  const resources = childOf(root, "Resources") ?? childOf(childOf(root, "resources"), "Resources");
  const res = childOf(resources, name);
  if (!res || !TABLE_TYPES.has(unquote(childOf(res, "Type")?.value ?? ""))) return null;
  const given = childOf(childOf(res, "Properties"), "TableName")?.value;
  return given ? fill(unquote(given), root, 0) : name;
}

function valueOf(n: SpecNode, root: SpecNode): string | null {
  const ref = childOf(n, "Ref")?.value;
  const raw = (n.value ?? "").trim();
  const named = ref ?? /^!Ref\s+([\w.-]+)$/.exec(raw)?.[1] ?? /^\{\s*["']?Ref["']?\s*:\s*["']?([\w.-]+)["']?\s*\}$/.exec(raw)?.[1];
  if (named) return tableOfRef(unquote(named), root);
  if (!raw || raw.startsWith("!") || raw.startsWith("{") || raw.startsWith("[")) return null;
  return fill(unquote(raw), root, 0);
}

function envOf(vars: SpecNode | undefined, root: SpecNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, node] of vars?.children ?? []) {
    const v = valueOf(node, root);
    if (v !== null) out[name] = v;
  }
  return out;
}

const join = (dir: string | null, file: string): string => {
  const d = (dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  return d && d !== "." ? `${d}/${file}` : file;
};

export function extractLambdaEnv(lines: string[], facts: RouteFact[] | undefined): void {
  if (!facts) return;
  const root = parseOpenApiDocument(lines);
  const push = (line: number, owner: string | undefined, data: LambdaEnv): void => {
    if (Object.keys(data.env).length > 0) facts.push({ kind: "lambda-env", line, ...(owner ? { owner } : {}), data });
  };
  if (root.children.has("Resources")) {
    const globals = childOf(childOf(root, "Globals"), "Function");
    const shared = envOf(childOf(childOf(globals, "Environment"), "Variables"), root);
    push(1, undefined, { handler: null, env: shared });
    for (const [name, res] of childOf(root, "Resources")?.children ?? []) {
      if (childOf(res, "Type")?.value !== "AWS::Serverless::Function") continue;
      const props = childOf(res, "Properties");
      const handler = childOf(props, "Handler")?.value ?? childOf(globals, "Handler")?.value ?? null;
      const codeUri = childOf(props, "CodeUri")?.value ?? childOf(globals, "CodeUri")?.value ?? null;
      const own = envOf(childOf(childOf(props, "Environment"), "Variables"), root);
      if (!handler) continue;
      push(res.line, name, { handler: handler.includes("::") ? handler : join(codeUri, handler), env: { ...shared, ...own } });
    }
    return;
  }
  push(1, undefined, { handler: null, env: envOf(childOf(childOf(root, "provider"), "environment"), root) });
  const providerEnv = envOf(childOf(childOf(root, "provider"), "environment"), root);
  for (const [name, fn] of childOf(root, "functions")?.children ?? []) {
    const handler = childOf(fn, "handler")?.value ?? null;
    const own = envOf(childOf(fn, "environment"), root);
    if (!handler) continue;
    push(fn.line, name, { handler, env: { ...providerEnv, ...own } });
  }
}
