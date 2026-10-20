import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { collectCdkRoutes, CDK_ROUTE, type CdkRouteFact } from "./cdk.js";
import type { RouteFact } from "../../../../types/analysis.js";

async function factsOf(src: string): Promise<string[]> {
  const tree = await parseSource(src, "typescript" as any, "lib/stack.ts");
  const facts: RouteFact[] = [];
  collectCdkRoutes(tree.rootNode, src, facts);
  return facts.filter((f) => f.kind === CDK_ROUTE).map((f) => {
    const d = f.data as CdkRouteFact;
    return `${d.method ?? "ANY"} ${d.path} ${d.lambda ? `${d.lambda.base}:${d.lambda.dir}|${d.lambda.spec}` : "-"}`;
  });
}

describe("CDK API Gateway routes", () => {
  it("reads resources, methods, chained resources, a proxy LambdaRestApi and HTTP API routes", async () => {
    expect(await factsOf(`import * as cdk from "aws-cdk-lib";
const fn = new lambda.Function(this, "Fn", { handler: "app.handler", code: lambda.Code.fromAsset(path.join(__dirname, "..", "functions")) });
const other = new lambda.Function(this, "Other", { handler: "x.y", code: lambda.Code.fromInline("…") });
const proxy = new apigw.LambdaRestApi(this, "Proxy", { handler: fn });
const closed = new apigw.LambdaRestApi(this, "Closed", { handler: fn, proxy: false });
closed.root.addResource("items").addResource("{id}").addMethod("DELETE", new apigw.LambdaIntegration(fn));
closed.root.resourceForPath("a/b").addMethod("ANY", new apigw.LambdaIntegration(other));
const http = new HttpApi(this, "Http");
http.addRoutes({ path: "/ping", integration: new HttpLambdaIntegration("P", fn) });`)).toEqual([
      "ANY /{proxy+} file:../functions|app.handler",
      "DELETE /items/{id} file:../functions|app.handler",
      "ANY /a/b -",
      "ANY /ping file:../functions|app.handler",
    ]);
  });

  it("reads nothing in a file that is not a CDK stack", async () => {
    expect(await factsOf(`const users = api.root.addResource("users"); users.addMethod("GET", x);`)).toEqual([]);
  });
});
