import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { boundIdentifiers, handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/** The first parameter of an Express/Fastify/Koa handler, as it is usually named. */
const REQUEST_PARAM = /^(?:req|request|ctx)$/;

const spec: TaintSpec = {
  functionTypes: new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "function"]),
  handler(fn) {
    const params = fn.childForFieldName("parameters")?.namedChildren ?? (fn.childForFieldName("parameter") ? [fn.childForFieldName("parameter")!] : []);
    const first = params[0];
    const name = first ? boundIdentifiers(first.type === "required_parameter" || first.type === "optional_parameter" ? first.childForFieldName("pattern") : first)[0] : undefined;
    // `(req, res)`, `(request, reply)`, `(ctx)`: the request object is the source regex's.
    if (!name || !REQUEST_PARAM.test(name)) return null;
    if (name === "ctx" && params.length > 2) return null;
    return { taintedParams: [] };
  },
  source: /\b(?:req|request)\.(?:query|body|params|headers|cookies)\b|\bctx\.(?:query|params|request\.(?:body|query))\b/,
  assignment(node) {
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      return value ? { names: boundIdentifiers(node.childForFieldName("name")), value } : null;
    }
    if (node.type === "assignment_expression" || node.type === "augmented_assignment_expression") {
      const value = node.childForFieldName("right");
      return value ? { names: boundIdentifiers(node.childForFieldName("left")), value } : null;
    }
    return null;
  },
  call(node) {
    if (node.type !== "call_expression" && node.type !== "new_expression") return null;
    const callee = (node.childForFieldName("function") ?? node.childForFieldName("constructor"))?.text;
    if (!callee) return null;
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    return { callee: callee.replace(/\s+/g, "").replace(/\?\./g, "."), args };
  },
  sanitizer: /^\s*(?:parseInt|parseFloat|Number|Boolean|encodeURIComponent|path\.basename|basename|escape|escapeHtml|validator\.\w+|DOMPurify\.sanitize|sanitize\w*|Math\.\w+)\s*\(/,
  propagator: /^(?:path\.(?:join|resolve|normalize)|String|URL|new URL|decodeURIComponent|.+\.(?:concat|replace|replaceAll|trim|toLowerCase|toUpperCase|join|toString|slice|substring|split))$/,
  ifTypes: new Set(["if_statement"]),
  sinks: [
    { callee: /\.(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)$|^(?:sequelize|knex)\.raw$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:exec|execSync|child_process\.(?:exec|execSync)|cp\.(?:exec|execSync)|shell\.exec)$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
    { callee: /^(?:fs\.(?:promises\.)?(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync)|res\.sendFile|res\.download)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
    { callee: /^(?:fetch|axios(?:\.(?:get|post|put|patch|delete|request))?|got|needle|superagent\.(?:get|post)|https?\.(?:get|request))$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
    { callee: /^(?:res|reply|ctx|response)\.redirect$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    { callee: /^(?:eval|Function)$/, category: "eval-exec", cwe: "CWE-95", what: "the code" },
  ],
};

/** Request input reaching a sink inside an Express/Fastify/Koa handler (see `handlerTaint`). */
export function javascriptTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath, facts);
}
