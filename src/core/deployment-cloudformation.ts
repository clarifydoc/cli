import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import { glob } from "./glob.js";
import { byOrdinal } from "./ordinal.js";
import { parseOpenApiDocument, type SpecNode } from "../extractors/plugins/openapi/index.js";
import type { DeployedServiceKind } from "../types/analysis.js";
import type { RawService } from "./deployment.js";
import type { TerraformDeployment } from "./deployment-terraform.js";

/**
 * Deployment evidence from CloudFormation and SAM templates (YAML or JSON), the
 * counterpart of `deployment-terraform.ts` with the same node and edge kinds:
 *
 *   AWS::Lambda::Function / AWS::Serverless::Function → an app: `CodeUri` (SAM) or a
 *                                  string `Code` is its build context, the `Handler`
 *                                  module its entry file, `Environment.Variables` its env
 *   AWS::SQS::Queue / AWS::SNS::Topic → queues
 *   AWS::DynamoDB::Table, AWS::Serverless::SimpleTable, AWS::RDS::DBInstance / DBCluster → datastores
 *   AWS::ElastiCache::*              → caches
 *
 * Edges are what the template states: a function's env value that `Ref`s or
 * `GetAtt`s a table, queue, topic or database, a SAM `Events` entry of type SQS /
 * DynamoDB / SNS or an `AWS::Lambda::EventSourceMapping` / `AWS::SNS::Subscription`
 * (a consumer's edge to its source, `event source`), and a SAM policy template
 * naming a resource (`DynamoDBCrudPolicy: { TableName: !Ref Table }`, `policy`).
 * Intrinsics are read in the short (`!Ref X`, `!GetAtt X.Arn`, `!Sub "${X}"`) and the long
 * (`{ "Ref": "X" }`, `Fn::GetAtt`, `Fn::Sub`) form. One template is one stack scope.
 */

const INFRA: Record<string, { kind: DeployedServiceKind; family: (props: SpecNode | undefined) => string; names: string[] }> = {
  "AWS::SQS::Queue": { kind: "queue", family: () => "sqs", names: ["QueueName"] },
  "AWS::SNS::Topic": { kind: "queue", family: () => "sns", names: ["TopicName"] },
  "AWS::DynamoDB::Table": { kind: "datastore", family: () => "dynamodb", names: ["TableName"] },
  "AWS::DynamoDB::GlobalTable": { kind: "datastore", family: () => "dynamodb", names: ["TableName"] },
  "AWS::Serverless::SimpleTable": { kind: "datastore", family: () => "dynamodb", names: ["TableName"] },
  "AWS::RDS::DBInstance": { kind: "datastore", family: (p) => engineFamily(p), names: ["DBInstanceIdentifier", "DBName"] },
  "AWS::RDS::DBCluster": { kind: "datastore", family: (p) => engineFamily(p), names: ["DBClusterIdentifier", "DatabaseName"] },
  "AWS::ElastiCache::CacheCluster": { kind: "cache", family: () => "redis", names: ["ClusterName"] },
  "AWS::ElastiCache::ReplicationGroup": { kind: "cache", family: () => "redis", names: ["ReplicationGroupId"] },
};
const FUNCTIONS = new Set(["AWS::Lambda::Function", "AWS::Serverless::Function"]);
const MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".py", ".rb"];
const GATE = /AWS::(?:Lambda|Serverless|SQS|SNS|DynamoDB|RDS|ElastiCache)::/;

function engineFamily(props: SpecNode | undefined): string {
  const e = lit(props?.children.get("Engine")) ?? "";
  return /postgres/.test(e) ? "postgres" : /mysql|maria/.test(e) ? "mysql" : /sqlserver/.test(e) ? "sqlserver" : /oracle/.test(e) ? "oracle" : "rds";
}

/** A scalar the template writes out (not an intrinsic). */
function lit(n: SpecNode | undefined): string | undefined {
  const v = n?.value;
  return v && !v.startsWith("!") && !v.includes("${") ? v : undefined;
}

/** The logical IDs an expression refers to, through `Ref`, `GetAtt` and `Sub`, short or long form. */
export function cfnRefs(n: SpecNode | undefined, sub = false, out: string[] = []): string[] {
  if (!n) return out;
  const text = n.value;
  if (text) {
    for (const m of text.matchAll(/!Ref\s+["']?([\w]+)/g)) out.push(m[1]!);
    for (const m of text.matchAll(/!GetAtt\s+\[?\s*["']?([\w]+)/g)) out.push(m[1]!);
    if (sub || text.startsWith("!Sub")) for (const m of text.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[\w.]+)?\}/g)) out.push(m[1]!);
  }
  for (const [k, c] of n.children) {
    if (k === "Ref") {
      if (c.value) out.push(c.value);
    } else if (k === "Fn::GetAtt") {
      const first = c.items?.[0]?.value ?? c.value?.split(".")[0];
      if (first) out.push(first);
    } else cfnRefs(c, sub || k === "Fn::Sub", out);
  }
  for (const i of n.items ?? []) cfnRefs(i, sub, out);
  return out;
}

/** An environment value as the env map keeps it: the literal, else the intrinsic written in short form. */
function envText(n: SpecNode): string {
  if (n.value !== null) return n.value;
  const ref = n.children.get("Ref")?.value;
  if (ref) return `!Ref ${ref}`;
  const at = cfnRefs(n)[0];
  return at ? `!GetAtt ${at}` : "";
}

export async function collectCloudFormation(projectRoot: string, ignore: readonly string[]): Promise<TerraformDeployment | undefined> {
  const absRoot = resolve(projectRoot);
  const found = (await glob(["**/*.{yml,yaml,json,template}"], { cwd: absRoot, ignore: [...ignore, "**/cdk.out/**", "**/.aws-sam/**"], absolute: false, deep: 6 }))
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !/(^|\/)(?:examples?|tests?|fixtures?)\//i.test(f))
    .sort(byOrdinal)
    .slice(0, 400);
  const out: TerraformDeployment = { files: [], groups: [], edges: [] };
  // Names drawn from a logical id, by the template that took them: a logical id is local to its stack.
  const logicalNames = new Map<string, string>();
  // Read in parallel batches (templates are found by content, so every YAML and JSON file is opened), judged in path order.
  const texts: Array<string | undefined> = [];
  for (let i = 0; i < found.length; i += 32) {
    texts.push(...(await Promise.all(found.slice(i, i + 32).map((f) => readFile(join(absRoot, f), "utf8").catch(() => undefined)))));
  }
  for (const [i, rel] of found.entries()) {
    const text = texts[i];
    if (text === undefined) continue;
    if (text.length > 2_000_000 || !GATE.test(text) || !/\bResources\b/.test(text)) continue;
    const root = parseOpenApiDocument(text.split(/\r?\n/));
    const resources = root.children.get("Resources");
    if (!resources || resources.children.size === 0) continue;
    const services = readTemplate(absRoot, rel, root, resources, out.edges, logicalNames);
    if (services.length === 0) continue;
    out.groups.push(services);
    out.files.push(rel);
  }
  return out.groups.length ? out : undefined;
}

function readTemplate(
  absRoot: string,
  rel: string,
  root: SpecNode,
  resources: SpecNode,
  edges: TerraformDeployment["edges"],
  logicalNames: Map<string, string>,
): RawService[] {
  const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
  const globals = root.children.get("Globals")?.children.get("Function");
  const services: RawService[] = [];
  const nameOf = new Map<string, string>(); // logical id → service name
  const typeOf = new Map<string, string>();
  const taken = new Set<string>();
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  // A physical name (`FunctionName`, `QueueName`, …) is the resource itself, so two templates naming it meet;
  // a logical id is local to its stack, so a second template's `ClubsFunction` is a different service.
  const named = (preferred: string, family: string, physical: boolean) => {
    let base = slug(preferred);
    if (!physical) {
      const owner = logicalNames.get(base);
      if (owner !== undefined && owner !== rel) base = `${base}-${slug(dir || "root")}`;
    }
    const name = taken.has(base) ? `${base}-${family}` : base;
    taken.add(name);
    if (!physical && !logicalNames.has(name)) logicalNames.set(name, rel);
    return name;
  };
  const entries = [...resources.children].map(([id, r]) => ({ id, r, type: r.children.get("Type")?.value ?? "", props: r.children.get("Properties") }));
  // Functions first, so a table sharing a function's name is the one renamed.
  const ordered = [...entries].sort((a, b) => Number(FUNCTIONS.has(b.type)) - Number(FUNCTIONS.has(a.type)));
  const pending: Array<{ from: string; refs: string[]; via: string; how: "env" | "event" | "policy" }> = [];
  for (const { id, type, props } of ordered) {
    if (FUNCTIONS.has(type)) {
      const fnName = lit(props?.children.get("FunctionName"));
      const name = named(fnName ?? id, "lambda", fnName !== undefined);
      const handler = lit(props?.children.get("Handler")) ?? lit(globals?.children.get("Handler"));
      const codeNode = props?.children.get("CodeUri") ?? props?.children.get("Code") ?? globals?.children.get("CodeUri");
      const code = lit(codeNode);
      let context: string | undefined;
      if (code && !/^s3:|^https?:/.test(code)) context = posix.normalize(posix.join(dir, code)).replace(/^\.\/?$/, "").replace(/^\.\//, "").replace(/\/$/, "");
      else if (codeNode === undefined && handler) context = dir;
      const env: Record<string, string> = {};
      const vars = [globals?.children.get("Environment")?.children.get("Variables"), props?.children.get("Environment")?.children.get("Variables")];
      for (const v of vars) for (const [k, c] of v?.children ?? []) env[k] = envText(c);
      const svc: RawService = { name, file: rel, entrypoint: handler, env, dependsOn: [], ports: [], ...(context !== undefined && !context.startsWith("..") ? { build: { context } } : {}) };
      if (context !== undefined && handler && handler.includes(".") && !handler.includes("::")) {
        const module = handler.slice(0, handler.lastIndexOf(".")).replace(/\./g, "/");
        for (const ext of MODULE_EXTENSIONS) {
          const cand = posix.join(context, module + ext);
          if (existsSync(join(absRoot, cand))) {
            svc.entryFile = cand;
            break;
          }
        }
        if (!svc.entryFile && codeNode === undefined) delete svc.build;
      }
      services.push(svc);
      nameOf.set(id, name);
      typeOf.set(id, type);
      for (const v of vars) for (const [k, c] of v?.children ?? []) pending.push({ from: id, refs: cfnRefs(c), via: k, how: "env" });
      for (const ev of props?.children.get("Events")?.children.values() ?? []) {
        const evType = ev.children.get("Type")?.value;
        const p = ev.children.get("Properties");
        const target = evType === "SQS" ? p?.children.get("Queue") : evType === "DynamoDB" ? p?.children.get("Stream") : evType === "SNS" ? p?.children.get("Topic") : undefined;
        if (target) pending.push({ from: id, refs: cfnRefs(target).slice(0, 1), via: "event source", how: "event" });
      }
      for (const policy of props?.children.get("Policies")?.items ?? []) pending.push({ from: id, refs: cfnRefs(policy), via: "policy", how: "policy" });
      continue;
    }
    const infra = INFRA[type];
    if (!infra) continue;
    const family = infra.family(props);
    const physical = infra.names.map((k) => lit(props?.children.get(k))).find(Boolean);
    const name = named(physical ?? id, family, physical !== undefined);
    services.push({ name, file: rel, env: {}, dependsOn: [], ports: [], kind: infra.kind, family, ...(infra.kind === "queue" ? { destination: true } : {}) });
    nameOf.set(id, name);
    typeOf.set(id, type);
  }
  for (const { id, type, props } of entries) {
    if (type === "AWS::Lambda::EventSourceMapping") {
      const fn = cfnRefs(props?.children.get("FunctionName"))[0];
      if (fn) pending.push({ from: fn, refs: cfnRefs(props?.children.get("EventSourceArn")).slice(0, 1), via: "event source", how: "event" });
    } else if (type === "AWS::SNS::Subscription") {
      const fn = cfnRefs(props?.children.get("Endpoint"))[0];
      if (fn) pending.push({ from: fn, refs: cfnRefs(props?.children.get("TopicArn")).slice(0, 1), via: "event source", how: "event" });
    } else if (type === "AWS::SNS::Topic") {
      for (const s of props?.children.get("Subscription")?.items ?? []) {
        const fn = cfnRefs(s.children.get("Endpoint"))[0];
        if (fn) pending.push({ from: fn, refs: [id], via: "event source", how: "event" });
      }
    }
  }
  const seen = new Set<string>();
  for (const e of pending) {
    const from = nameOf.get(e.from);
    if (!from || !FUNCTIONS.has(typeOf.get(e.from) ?? "")) continue;
    for (const ref of e.refs) {
      const t = typeOf.get(ref);
      const infra = t ? INFRA[t] : undefined;
      const to = nameOf.get(ref);
      if (!infra || !to) continue;
      const key = `${from}|${to}|${e.via}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: e.how === "event" || infra.kind === "queue" ? "bus" : "db", via: e.via });
    }
  }
  return services;
}
