import type { RouteFact } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { parseHcl, type HclBlock } from "../../shared/hcl.js";

/**
 * Terraform files as facts for the module-level route pass (`routes.ts`):
 * the blocks an API Gateway route is assembled from — they are usually
 * spread over several files of one module (`api.tf`, `lambda.tf`) — each with
 * the attributes the pass reads, as written.
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
  aws_s3_object: ["source"],
  aws_s3_bucket_object: ["source"],
  "data.archive_file": ["source_dir", "source_file", "output_path"],
};

export interface TerraformBlockFact {
  type: string;
  name: string;
  line: number;
  attrs: Record<string, string>;
}

export function collectTerraformFacts(text: string, facts: RouteFact[] | undefined): void {
  if (!facts || !/\b(?:aws_apigatewayv2_|aws_api_gateway_|aws_lambda_function|archive_file|aws_s3_(?:bucket_)?object)/.test(text)) return;
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
  extractRoutes: (lines, _classes, _file, _fns, facts) => {
    collectTerraformFacts(lines.join("\n"), facts);
    return [];
  },
};
