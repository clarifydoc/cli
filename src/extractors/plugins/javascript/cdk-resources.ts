import type { Node, Tree } from "web-tree-sitter";
import type { DeployedResourceFact, DeployedServiceKind } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * AWS CDK constructs as deployment evidence — what a stack creates and how it
 * wires them, so a CDK app shows the same services a compose file or a
 * Terraform module would:
 *
 *   const orders = new sqs.Queue(this, "Orders", { queueName: "orders" });   → queue "orders" (sqs)
 *   const table = new dynamodb.Table(this, "OrdersTable", { … });             → datastore "OrdersTable" (dynamodb)
 *   const fn = new lambda.Function(this, "Worker", { handler: "w.handle",
 *     environment: { QUEUE_URL: orders.queueUrl } });                         → app "Worker" (lambda), env QUEUE_URL → orders
 *   orders.grantConsumeMessages(fn); table.grantReadWriteData(fn);            → Worker → orders (bus), Worker → OrdersTable (db)
 *   fn.addEventSource(new SqsEventSource(orders));                            → Worker → orders (bus, event source)
 *
 * A resource is named by the name its props give it (`queueName`,
 * `tableName`, `functionName`, …), else by its construct id.
 */
const CONSTRUCTS: Array<{ re: RegExp; kind: DeployedServiceKind; family: string; nameProp: string }> = [
  { re: /(?:^|\.)Queue$/, kind: "queue", family: "sqs", nameProp: "queueName" },
  { re: /(?:^|\.)Topic$/, kind: "queue", family: "sns", nameProp: "topicName" },
  { re: /(?:^|\.)(?:Table|TableV2)$/, kind: "datastore", family: "dynamodb", nameProp: "tableName" },
  { re: /(?:^|\.)Bucket$/, kind: "datastore", family: "s3", nameProp: "bucketName" },
  { re: /(?:^|\.)(?:DatabaseInstance|DatabaseCluster|ServerlessCluster)$/, kind: "datastore", family: "rds", nameProp: "databaseName" },
  { re: /(?:^|\.)(?:Function|NodejsFunction|PythonFunction|DockerImageFunction)$/, kind: "app", family: "lambda", nameProp: "functionName" },
  { re: /(?:^|\.)(?:CfnCacheCluster|CfnReplicationGroup)$/, kind: "cache", family: "redis", nameProp: "clusterName" },
];

const args = (n: Node): Node[] => n.childForFieldName("arguments")?.namedChildren ?? [];
const str = (n: Node | null | undefined): string | null => (n && (n.type === "string" || (n.type === "template_string" && !n.text.includes("${"))) ? stripQuotes(n.text) : null);
function propOf(obj: Node | null | undefined, key: string): Node | null {
  for (const p of obj?.type === "object" ? obj.namedChildren : []) {
    if (p.type === "pair" && stripQuotes(p.childForFieldName("key")?.text ?? "") === key) return p.childForFieldName("value");
  }
  return null;
}

/** Methods that grant a function access to a resource: what it may do there. */
const GRANT_RE = /^grant(?:SendMessages|ConsumeMessages|Publish|Subscribe|Read|Write|ReadWrite|ReadData|WriteData|ReadWriteData|FullAccess|Connect|DataApiAccess|Put|Delete)?$/;

export function extractCdkResources(tree: Tree, sourceText: string): DeployedResourceFact[] {
  if (!/aws-cdk-lib|@aws-cdk\//.test(sourceText)) return [];
  const byVar = new Map<string, DeployedResourceFact>();
  const out: DeployedResourceFact[] = [];
  const edgeKind = (r: DeployedResourceFact): "bus" | "db" | "http" => (r.kind === "queue" ? "bus" : r.kind === "app" ? "http" : "db");
  const link = (from: DeployedResourceFact | undefined, to: DeployedResourceFact | undefined, via: string) => {
    if (!from || !to || from === to) return;
    const edges = (from.edges ??= []);
    if (!edges.some((e) => e.to === to.name && e.via === via)) edges.push({ to: to.name, kind: edgeKind(to), via });
  };
  // The variable an expression's root names: `orders.queueUrl` → orders, `this.orders` → orders.
  const rootVar = (n: Node | null | undefined): string | null => {
    let cur = n;
    while (cur?.type === "member_expression") {
      const obj: Node | null = cur.childForFieldName("object");
      if (obj?.type === "this") return cur.childForFieldName("property")?.text ?? null;
      cur = obj;
    }
    return cur?.type === "identifier" ? cur.text : null;
  };

  const declare = (holder: string, value: Node) => {
    const ctor = value.childForFieldName("constructor")?.text ?? "";
    const spec = CONSTRUCTS.find((c) => c.re.test(ctor));
    if (!spec) return;
    const a = args(value);
    const props = a[2] ?? null;
    const name = str(propOf(props, spec.nameProp)) ?? str(a[1]) ?? holder;
    const fact: DeployedResourceFact = { name, kind: spec.kind, family: spec.family, line: value.startPosition.row + 1 };
    const handler = str(propOf(props, "handler"));
    if (handler) fact.handler = handler;
    byVar.set(holder, fact);
    out.push(fact);
    // `environment: { QUEUE_URL: orders.queueUrl, STAGE: "prod" }`: names always, values when literal, edges for references.
    const env = propOf(props, "environment");
    for (const p of env?.type === "object" ? env.namedChildren : []) {
      if (p.type !== "pair") continue;
      const key = stripQuotes(p.childForFieldName("key")?.text ?? "");
      const v = p.childForFieldName("value");
      (fact.env ??= {})[key] = str(v) ?? `\${${v?.text ?? ""}}`;
      pendingEnv.push({ from: fact, ref: rootVar(v), via: key });
    }
  };
  const pendingEnv: Array<{ from: DeployedResourceFact; ref: string | null; via: string }> = [];
  const pendingCalls: Array<{ target: string | null; method: string; arg: Node | undefined }> = [];

  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const holder = n.childForFieldName("name")?.text;
      const value = n.childForFieldName("value");
      if (holder && value?.type === "new_expression") declare(holder, value);
    } else if (n.type === "assignment_expression") {
      // `this.orders = new sqs.Queue(…)` in a construct's constructor.
      const left = n.childForFieldName("left");
      const value = n.childForFieldName("right");
      const holder = left?.type === "member_expression" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("property")?.text : undefined;
      if (holder && value?.type === "new_expression") declare(holder, value);
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn?.type === "member_expression") {
        const method = fn.childForFieldName("property")?.text ?? "";
        if (GRANT_RE.test(method) || method === "addEventSource" || method === "addSubscription") pendingCalls.push({ target: rootVar(fn.childForFieldName("object")), method, arg: args(n)[0] });
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);

  for (const e of pendingEnv) link(e.from, e.ref ? byVar.get(e.ref) : undefined, e.via);
  for (const c of pendingCalls) {
    const target = c.target ? byVar.get(c.target) : undefined;
    if (c.method === "addEventSource" || c.method === "addSubscription") {
      // `fn.addEventSource(new SqsEventSource(queue))`; `topic.addSubscription(new LambdaSubscription(fn))`.
      const inner = c.arg?.type === "new_expression" ? args(c.arg)[0] : c.arg;
      const other = byVar.get(rootVar(inner) ?? "");
      if (c.method === "addEventSource") link(target, other, "event source");
      else link(other, target, "subscription");
    } else {
      // `queue.grantSendMessages(fn)`: the function is given access to the resource.
      link(byVar.get(rootVar(c.arg) ?? ""), target, c.method);
    }
  }
  return out;
}
