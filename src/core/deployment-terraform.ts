import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import { glob } from "./glob.js";
import { byOrdinal } from "./ordinal.js";
import { hclPath, hclRefs, hclString, parseHcl, type HclBlock } from "../extractors/shared/hcl.js";
import type { DeployedServiceKind } from "../types/analysis.js";
import type { RawService } from "./deployment.js";

/**
 * Deployment evidence from Terraform: what an AWS module runs and attaches.
 *
 *   aws_lambda_function            → an app: its code directory (an
 *                                    `archive_file` `source_dir`) is its build
 *                                    context, its handler module its entry
 *                                    file, `environment.variables` its env
 *   aws_sqs_queue / aws_sns_topic  → queues
 *   aws_dynamodb_table, aws_db_instance / aws_rds_cluster → datastores
 *   aws_elasticache_*              → caches
 *
 * Edges are what the module states: a function's env referencing a queue,
 * table or database (`QUEUE_URL = aws_sqs_queue.jobs.url`), and an
 * `aws_lambda_event_source_mapping` from a queue to a function. One module
 * directory is one stack scope, as one compose file is.
 */

export interface TerraformDeployment {
  files: string[];
  groups: RawService[][];
  edges: Array<{ from: string; to: string; kind: "bus" | "db" | "http"; via: string }>;
}

const INFRA: Record<string, { kind: DeployedServiceKind; family: (b: HclBlock) => string }> = {
  aws_sqs_queue: { kind: "queue", family: () => "sqs" },
  aws_sns_topic: { kind: "queue", family: () => "sns" },
  aws_dynamodb_table: { kind: "datastore", family: () => "dynamodb" },
  aws_db_instance: { kind: "datastore", family: (b) => engineFamily(b) },
  aws_rds_cluster: { kind: "datastore", family: (b) => engineFamily(b) },
  aws_elasticache_cluster: { kind: "cache", family: () => "redis" },
  aws_elasticache_replication_group: { kind: "cache", family: () => "redis" },
};

function engineFamily(b: HclBlock): string {
  const e = hclString(b.attrs.get("engine")) ?? "";
  return /postgres/.test(e) ? "postgres" : /mysql|maria/.test(e) ? "mysql" : /sqlserver/.test(e) ? "sqlserver" : /oracle/.test(e) ? "oracle" : "rds";
}

const MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".py", ".rb"];

export async function collectTerraform(projectRoot: string, ignore: readonly string[]): Promise<TerraformDeployment | undefined> {
  const absRoot = resolve(projectRoot);
  const found = (await glob(["**/*.tf"], { cwd: absRoot, ignore: [...ignore, "**/.terraform/**"], absolute: false, deep: 6 }))
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !/(^|\/)(?:examples?|tests?|fixtures?)\//i.test(f))
    .sort(byOrdinal)
    .slice(0, 200);
  if (found.length === 0) return undefined;

  // One module per directory: its blocks, by address.
  const modules = new Map<string, Array<{ block: HclBlock; file: string }>>();
  for (const rel of found) {
    let text: string;
    try {
      text = await readFile(join(absRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (text.length > 1_000_000 || !/\baws_(?:lambda_function|sqs_queue|sns_topic|dynamodb_table|db_instance|rds_cluster|elasticache)/.test(text)) continue;
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    const list = modules.get(dir) ?? modules.set(dir, []).get(dir)!;
    for (const block of parseHcl(text)) if (block.type === "resource" || block.type === "data") list.push({ block, file: rel });
  }

  const out: TerraformDeployment = { files: [], groups: [], edges: [] };
  for (const [dir, list] of modules) {
    const addr = new Map(list.map((x) => [`${x.block.type === "data" ? "data." : ""}${x.block.labels[0]}.${x.block.labels[1]}`, x]));
    const services: RawService[] = [];
    const nameOf = new Map<string, string>(); // address → service name
    const taken = new Set<string>();
    const named = (preferred: string, family: string) => {
      const base = preferred.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
      const name = taken.has(base) ? `${base}-${family}` : base;
      taken.add(name);
      return name;
    };
    const files = new Set<string>();
    const edges: TerraformDeployment["edges"] = [];
    // Functions first, so a table sharing a function's name is the one renamed.
    const ordered = [...list].sort((a, b) => Number(b.block.labels[0] === "aws_lambda_function") - Number(a.block.labels[0] === "aws_lambda_function"));
    for (const { block, file } of ordered) {
      if (block.type !== "resource") continue;
      const [type, label] = block.labels;
      if (!type || !label) continue;
      if (type === "aws_lambda_function") {
        const name = named(hclString(block.attrs.get("function_name")) ?? label, "lambda");
        const handler = hclString(block.attrs.get("handler")) ?? undefined;
        // The archive of its code: named by `filename` or `source_code_hash`, or uploaded as an S3 object `s3_key` names.
        const s3 = hclRefs(block.attrs.get("s3_key")).find((r) => r.type === "aws_s3_object" || r.type === "aws_s3_bucket_object");
        const s3Block = s3 ? addr.get(`${s3.type}.${s3.name}`)?.block : undefined;
        const archive = [block.attrs.get("filename"), block.attrs.get("source_code_hash"), s3Block?.attrs.get("source")].flatMap((e) => hclRefs(e)).find((r) => r.type === "data.archive_file");
        const a = archive ? addr.get(`data.archive_file.${archive.name}`)?.block : undefined;
        const src = a ? hclPath(a.attrs.get("source_dir"), dir) ?? hclPath(a.attrs.get("source_file"), dir)?.replace(/\/[^/]*$/, "") : null;
        const context = src ? posix.normalize(src).replace(/^\.\/?/, "").replace(/\/$/, "") : undefined;
        const env: Record<string, string> = {};
        const vars = block.blocks.find((b) => b.type === "environment")?.attrs.get("variables");
        for (const m of (vars ?? "").matchAll(/^\s*([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/gm)) env[m[1]!] = hclString(m[2]) ?? m[2]!;
        const svc: RawService = { name, file, entrypoint: handler, env, dependsOn: [], ports: [], ...(context !== undefined && !context.startsWith("..") ? { build: { context } } : {}) };
        if (context !== undefined && handler && handler.includes(".")) {
          const module = handler.slice(0, handler.lastIndexOf(".")).replace(/\./g, "/");
          for (const ext of MODULE_EXTENSIONS) {
            const cand = posix.join(context, module + ext);
            if (existsSync(join(absRoot, cand))) {
              svc.entryFile = cand;
              break;
            }
          }
        }
        services.push(svc);
        nameOf.set(`${type}.${label}`, name);
        files.add(file);
        // Edges from what its env references.
        for (const [k, v] of Object.entries(env)) {
          for (const r of hclRefs(v)) {
            const target = INFRA[r.type] ? `${r.type}.${r.name}` : r.type === "aws_lambda_function" || r.type === "aws_lambda_function_url" ? `aws_lambda_function.${r.name}` : null;
            if (target) edges.push({ from: `${type}.${label}`, to: target, kind: INFRA[r.type]?.kind === "queue" ? "bus" : INFRA[r.type] ? "db" : "http", via: k });
          }
        }
        continue;
      }
      const infra = INFRA[type];
      if (!infra) {
        if (type === "aws_lambda_event_source_mapping") {
          const source = hclRefs(block.attrs.get("event_source_arn"))[0];
          const fn = hclRefs(block.attrs.get("function_name")).find((r) => r.type === "aws_lambda_function");
          if (source && fn && INFRA[source.type]) edges.push({ from: `aws_lambda_function.${fn.name}`, to: `${source.type}.${source.name}`, kind: "bus", via: "event source" });
        }
        continue;
      }
      const family = infra.family(block);
      const preferred = hclString(block.attrs.get("name")) ?? hclString(block.attrs.get("identifier")) ?? hclString(block.attrs.get("db_name")) ?? hclString(block.attrs.get("cluster_identifier")) ?? label;
      const name = named(preferred, family);
      services.push({ name, file, env: {}, dependsOn: [], ports: [], kind: infra.kind, family });
      nameOf.set(`${type}.${label}`, name);
      files.add(file);
    }
    if (services.length === 0) continue;
    // Edges by address → by service name; one the module cannot name is dropped.
    for (const e of edges) {
      const from = nameOf.get(e.from);
      const to = nameOf.get(e.to);
      if (from && to) out.edges.push({ ...e, from, to });
    }
    out.groups.push(services);
    out.files.push([...files].sort(byOrdinal)[0]!);
  }
  return out.groups.length ? out : undefined;
}
