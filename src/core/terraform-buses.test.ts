import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { collectTerraform } from "./deployment-terraform.js";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-tfb-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const QUEUE_MODULE = `
resource "aws_sqs_queue" "this" { name = "garage-jobs" }
resource "aws_sqs_queue" "decoy" { name = "league-other" }
output "url" { value = aws_sqs_queue.this.url }
output "arn" { value = aws_sqs_queue.this.arn }
`;
const WORKER_MODULE = `
variable "queue_url" {}
variable "queue_arn" { default = "" }
resource "aws_lambda_function" "cars" {
  function_name = "cars"
  handler = "handler.run"
  environment {
    variables = {
      QUEUE_URL = var.queue_url
    }
  }
}
resource "aws_lambda_event_source_mapping" "m" {
  event_source_arn = var.queue_arn
  function_name = aws_lambda_function.cars.arn
}
`;

const edges = async (files: Record<string, string>) => {
  const dir = await project(files);
  try {
    const tf = await collectTerraform(dir, []);
    return (tf?.edges ?? []).map((e) => `${e.from} → ${e.to} [${e.kind}] ${e.via}`).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("Terraform module wiring", () => {
  it("follows a module output through a local into another module's variable", async () => {
    expect(
      await edges({
        "infra/main.tf": `
locals { jobs = module.queue.url }
module "queue" { source = "./modules/queue" }
module "worker" {
  source = "./modules/worker"
  queue_url = local.jobs
  queue_arn = module.queue.arn
}`,
        "infra/modules/queue/main.tf": QUEUE_MODULE,
        "infra/modules/worker/main.tf": WORKER_MODULE,
      }),
    ).toEqual(["cars → garage-jobs [bus] QUEUE_URL", "cars → garage-jobs [bus] event source"]);
  });

  it("reads a resource referenced in a module argument, and a variable's default", async () => {
    expect(
      await edges({
        "main.tf": `
resource "aws_sqs_queue" "jobs" { name = "garage-jobs" }
module "worker" {
  source = "./worker"
  queue_url = aws_sqs_queue.jobs.url
}`,
        "worker/main.tf": WORKER_MODULE.replace('default = ""', 'default = "x"'),
      }),
    ).toEqual(["cars → garage-jobs [bus] QUEUE_URL"]);
  });

  it("names no queue for a variable whose callers disagree", async () => {
    expect(
      await edges({
        "main.tf": `
resource "aws_sqs_queue" "jobs" { name = "garage-jobs" }
resource "aws_sqs_queue" "other" { name = "league-other" }
module "a" {
  source = "./worker"
  queue_url = aws_sqs_queue.jobs.url
}
module "b" {
  source = "./worker"
  queue_url = aws_sqs_queue.other.url
}`,
        "worker/main.tf": WORKER_MODULE,
      }),
    ).toEqual([]);
  });

  it("ignores a registry module source", async () => {
    expect(
      await edges({
        "main.tf": `
resource "aws_sqs_queue" "jobs" { name = "garage-jobs" }
module "worker" {
  source = "terraform-aws-modules/lambda/aws"
  queue_url = aws_sqs_queue.jobs.url
}`,
        "worker/main.tf": WORKER_MODULE,
      }),
    ).toEqual([]);
  });
});

describe("a function publishing on the variable that holds a queue's URL", () => {
  const code = (name: string) => `import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
const sqs = new SQSClient({});
export async function ${name}() {
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: "x" }));
}
`;
  it("meets the queue the deployment gives the variable, and only in the project that runs the function", async () => {
    const dir = await project({
      "infra/main.tf": `
resource "aws_sqs_queue" "jobs" { name = "garage-jobs" }
data "archive_file" "cars" {
  type = "zip"
  source_dir = "\${path.module}/../src/cars"
  output_path = "cars.zip"
}
resource "aws_lambda_function" "cars" {
  function_name = "cars"
  handler = "handler.run"
  filename = data.archive_file.cars.output_path
  environment {
    variables = {
      QUEUE_URL = aws_sqs_queue.jobs.url
    }
  }
}`,
      "src/cars/package.json": `{"name":"cars"}`,
      "src/cars/handler.ts": code("run"),
      "src/decoy/package.json": `{"name":"decoy"}`,
      "src/decoy/other.ts": code("other"),
    });
    const out = join(dir, "out");
    try {
      await analyze({ projectRoot: dir, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
      const s = await loadReportSummary(out);
      expect((s.symbolDataAccess ?? []).map((d) => `${d.symbol} → ${d.datastore} ${d.access}`).sort()).toEqual([
        "other → QUEUE_URL queue-publish",
        "run → garage-jobs queue-publish",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
