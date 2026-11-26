import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { parseHcl, type HclBlock } from "../../shared/hcl.js";

/**
 * Terraform files as facts for the module-level route pass (`routes.ts`):
 * the blocks an API Gateway route is assembled from — they are usually
 * spread over several files of one module (`api.tf`, `lambda.tf`) — each with
 * the attributes the pass reads, as written. A `variable "x"` block is `FileAnalysis.configKeyReads` (spec
 * `extractConfigKeyReads`), never a data source.
 */

export const TERRAFORM_BLOCK = "terraform-block";

/** Resource types, and the attributes of each the route pass reads. */
const READ: Record<string, readonly string[]> = {
  aws_apigatewayv2_api: ["name", "protocol_type"],
  aws_apigatewayv2_route: ["api_id", "route_key", "target", "authorization_type", "authorizer_id"],
  aws_apigatewayv2_integration: ["api_id", "integration_uri", "integration_type"],
  aws_api_gateway_rest_api: ["name"],
  aws_api_gateway_resource: ["rest_api_id", "parent_id", "path_part"],
  aws_api_gateway_method: ["rest_api_id", "resource_id", "http_method", "authorization", "authorizer_id"],
  aws_api_gateway_integration: ["rest_api_id", "resource_id", "http_method", "uri", "type"],
  aws_lambda_function: ["function_name", "handler", "filename", "s3_key", "source_code_hash", "image_uri", "runtime"],
  aws_dynamodb_table: ["name"],
  aws_s3_object: ["source"],
  aws_s3_bucket_object: ["source"],
  "data.archive_file": ["source_dir", "source_file", "output_path"],
};

export interface TerraformBlockFact {
  type: string;
  name: string;
  line: number;
  attrs: Record<string, string>;
  /** A function's `environment { variables = { NAME = expr } }`, each expression as written. */
  env?: Record<string, string>;
}

export function collectTerraformFacts(text: string, facts: RouteFact[] | undefined): void {
  if (!facts || !/\b(?:aws_apigatewayv2_|aws_api_gateway_|aws_lambda_function|aws_dynamodb_table|archive_file|aws_s3_(?:bucket_)?object)/.test(text)) return;
  for (const b of parseHcl(text)) {
    if (b.type !== "resource" && b.type !== "data") continue;
    const type = (b.type === "data" ? "data." : "") + (b.labels[0] ?? "");
    const keep = READ[type];
    if (!keep || !b.labels[1]) continue;
    const attrs: Record<string, string> = {};
    for (const k of keep) {
      const v = b.attrs.get(k);
      if (v !== undefined) attrs[k] = v;
    }
    const data: TerraformBlockFact = { type, name: b.labels[1], line: b.line, attrs };
    if (type === "aws_lambda_function") {
      const vars = b.blocks.find((x) => x.type === "environment")?.attrs.get("variables");
      const env: Record<string, string> = {};
      // `NAME = expr` per line, or several in one line (`{ A = "x", B = "y" }`); a key may be quoted.
      for (const m of (vars ?? "").matchAll(/(?:^|[\n,{])\s*"?([A-Za-z_]\w*)"?\s*=\s*("(?:[^"\\]|\\.)*"|[^\n,}]+?)\s*(?=[\n,}]|$)/g)) env[m[1]!] = m[2]!;
      if (Object.keys(env).length > 0) data.env = env;
    }
    facts.push({ kind: TERRAFORM_BLOCK, line: b.line, data });
  }
}

export type { HclBlock };

export const terraformSpec: RegexLangSpec = {
  language: "terraform",
  extensions: [".tf"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["#", "//"],
  // `variable "x" {` takes the key `x` a `*.tfvars` file beside it sets.
  extractConfigKeyReads: (lines) => {
    const out: NonNullable<FileAnalysis["configKeyReads"]> = [];
    lines.forEach((l, i) => {
      const key = /^\s*variable\s+"([^"]+)"/.exec(l)?.[1];
      if (key) out.push({ key, line: i + 1, kind: "variable" });
    });
    return out;
  },
  extractRoutes: (lines, _classes, _file, _fns, facts) => {
    collectTerraformFacts(lines.join("\n"), facts);
    return [];
  },
};
