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

describe("CDK constructs built in helpers, and the infrastructure a stack declares", () => {
  it("follows a helper that builds the Lambda, binding its parameters to the call's arguments", async () => {
    expect(await factsOf(`import * as cdk from "aws-cdk-lib";
function makeFn(scope: Construct, id: string, handler: string) {
  return new lambda.Function(scope, id, { handler, runtime: lambda.Runtime.NODEJS_20_X, code: lambda.Code.fromAsset("lambda") });
}
const node = (scope: Construct, id: string, file: string) => new NodejsFunction(scope, id, { entry: path.join(__dirname, "../src", file) });
const list = makeFn(this, "List", "users.list");
const get = node(this, "Get", "get.ts");
const api = new apigw.RestApi(this, "Api");
const users = api.root.addResource("users");
users.addMethod("GET", new apigw.LambdaIntegration(list));
users.addResource("{id}").addMethod("GET", new apigw.LambdaIntegration(get));`)).toEqual([
      "GET /users cwd:lambda|users.list",
      "GET /users/{id} file:../src|get.handler",
    ]);
  });

  it("names the queues, tables and functions a stack creates, and how it wires them", async () => {
    const { extractCdkResources } = await import("../cdk-resources.js");
    const src = `import * as cdk from "aws-cdk-lib";
export class Shop extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const orders = new sqs.Queue(this, "Orders", { queueName: "orders" });
    this.table = new dynamodb.Table(this, "OrdersTable", { partitionKey: { name: "id", type: AttributeType.STRING } });
    const worker = new lambda.Function(this, "Worker", { handler: "worker.handle", environment: { QUEUE_URL: orders.queueUrl, STAGE: "prod" } });
    orders.grantConsumeMessages(worker);
    this.table.grantReadWriteData(worker);
    worker.addEventSource(new SqsEventSource(orders));
  }
}`;
    const got = extractCdkResources(await parseSource(src, "typescript" as never, "lib/shop.ts"), src);
    expect(got.map((r) => `${r.kind}/${r.family} ${r.name}${r.handler ? ` ${r.handler}` : ""}${r.edges ? ` → ${r.edges.map((e) => `${e.to}(${e.kind}, ${e.via})`).join(", ")}` : ""}`)).toEqual([
      "queue/sqs orders",
      "datastore/dynamodb OrdersTable",
      "app/lambda Worker worker.handle → orders(bus, QUEUE_URL), orders(bus, grantConsumeMessages), OrdersTable(db, grantReadWriteData), orders(bus, event source)",
    ]);
    expect(got[2]!.env).toEqual({ QUEUE_URL: "${orders.queueUrl}", STAGE: "prod" });
  });
});
