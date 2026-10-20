import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { hclPath, hclRefs, hclString } from "../../shared/hcl.js";
import { lambdaModuleHandler } from "../shared/lambda-handlers.js";
import { TERRAFORM_BLOCK, type TerraformBlockFact } from "./index.js";

/**
 * API Gateway routes declared in Terraform, on the Lambda handlers they invoke.
 *
 *   resource "aws_apigatewayv2_route" "get_order" {          HTTP API (v2)
 *     route_key = "GET /orders/{id}"
 *     target    = "integrations/${aws_apigatewayv2_integration.orders.id}"
 *   }
 *   resource "aws_apigatewayv2_integration" "orders" { integration_uri = aws_lambda_function.orders.invoke_arn }
 *   resource "aws_lambda_function" "orders" { handler = "index.handler", filename = data.archive_file.orders.output_path }
 *   data "archive_file" "orders" { source_dir = "${path.module}/../src/orders" }
 *                                    → GET /orders/{id} on `handler` of src/orders/index.ts
 *
 * REST APIs (v1) compose the path from `aws_api_gateway_resource` path parts
 * up the `parent_id` chain; the method and its integration say the verb and
 * the function. The blocks are joined within one module directory. A route
 * whose function's code the module does not point at (a prebuilt zip, an
 * image) stays on the `.tf` file that declares it.
 */

interface Block extends TerraformBlockFact {
  file: FileAnalysis;
}

const key = (type: string, name: string) => `${type}.${name}`;

export const terraformRoutes: RouteResolver = {
  id: "terraform-api-gateway",
  languages: ["terraform", "typescript", "javascript", "python", "ruby"],
  priority: 50,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const byDir = new Map<string, Map<string, Block>>();
    for (const a of analyses) {
      if (a.language !== "terraform") continue;
      const dir = a.filePath.includes("/") ? a.filePath.slice(0, a.filePath.lastIndexOf("/")) : "";
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== TERRAFORM_BLOCK) continue;
        const b = f.data as TerraformBlockFact;
        const blocks = byDir.get(dir) ?? byDir.set(dir, new Map()).get(dir)!;
        blocks.set(key(b.type, b.name), { ...b, file: a });
      }
    }
    for (const [dir, blocks] of byDir) {
      const ref = (expr: string | undefined, type: string): Block | undefined => {
        const r = hclRefs(expr).find((x) => x.type === type);
        return r ? blocks.get(key(r.type, r.name)) : undefined;
      };
      /** `index.handler` under the function's code directory, relative to this module. */
      const handlerOf = (fn: Block | undefined): string | null => {
        const handler = hclString(fn?.attrs.handler);
        if (!fn || !handler) return null;
        // The archive of its code: named by `filename` or `source_code_hash`, or uploaded as an S3 object `s3_key` names.
        const s3 = ref(fn.attrs.s3_key, "aws_s3_object") ?? ref(fn.attrs.s3_key, "aws_s3_bucket_object");
        const archive = ref(fn.attrs.filename, "data.archive_file") ?? ref(fn.attrs.source_code_hash, "data.archive_file") ?? ref(s3?.attrs.source, "data.archive_file");
        const src = archive ? hclPath(archive.attrs.source_dir, ".") ?? (hclPath(archive.attrs.source_file, ".")?.replace(/\/[^/]*$/, "") ?? null) : null;
        // Relative to the module: the handler kit joins it onto the module's directory (`..` included).
        return src ? `${src.replace(/\/+$/, "")}/${handler}` : null;
      };
      const emit = (decl: Block, method: string | null, path: string, fn: Block | undefined, extra: Partial<RouteInfo>) => {
        const spec = handlerOf(fn);
        const hit = spec ? lambdaModuleHandler(spec, dir, ctx) : null;
        const route: RouteInfo = { path, httpMethod: method, kind: "api", handler: hit ? hit.handler : hclString(fn?.attrs.function_name) ?? fn?.name ?? null, calls: hit ? hit.fn.calls : [], middleware: [], line: hit ? hit.fn.line : decl.line, ...extra };
        (hit ? hit.file : decl.file).routes.push(route);
      };
      for (const b of blocks.values()) {
        if (b.type === "aws_apigatewayv2_route") {
          const rk = hclString(b.attrs.route_key);
          const m = rk ? /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(\/\S*)$/.exec(rk) : null;
          if (!m) continue; // `$default`, a WebSocket route key
          const integration = ref(b.attrs.target, "aws_apigatewayv2_integration");
          const fn = ref(integration?.attrs.integration_uri, "aws_lambda_function");
          const authType = hclString(b.attrs.authorization_type);
          emit(b, m[1] === "ANY" ? null : m[1]!, m[2]!.replace(/\{([^}+]+)\+\}/g, "*"), fn, authType && authType !== "NONE" ? { middleware: [authType], auth: { policies: [], roles: [], schemes: [authType], anonymous: false, inherited: false } } : {});
        } else if (b.type === "aws_api_gateway_method") {
          // The path: path parts up the parent chain to the API's root.
          const parts: string[] = [];
          let res = ref(b.attrs.resource_id, "aws_api_gateway_resource");
          for (let guard = 0; res && guard < 20; guard++) {
            parts.unshift(hclString(res.attrs.path_part) ?? "{?}");
            res = ref(res.attrs.parent_id, "aws_api_gateway_resource");
          }
          const verb = hclString(b.attrs.http_method);
          if (!verb) continue;
          const integration = [...blocks.values()].find((i) => i.type === "aws_api_gateway_integration" && ref(i.attrs.resource_id, "aws_api_gateway_resource")?.name === ref(b.attrs.resource_id, "aws_api_gateway_resource")?.name && (i.attrs.http_method === b.attrs.http_method || ref(i.attrs.http_method, "aws_api_gateway_method")?.name === b.name));
          const fn = ref(integration?.attrs.uri, "aws_lambda_function");
          const auth = hclString(b.attrs.authorization);
          emit(b, verb === "ANY" ? null : verb.toUpperCase(), "/" + parts.join("/").replace(/\{([^}+]+)\+\}/g, "*"), fn, auth && auth !== "NONE" ? { middleware: [auth], auth: { policies: [], roles: [], schemes: [auth], anonymous: false, inherited: false } } : {});
        }
      }
    }
  },
};
