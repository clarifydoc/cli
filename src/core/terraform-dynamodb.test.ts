import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A DynamoDB client names its table by an environment variable; the Terraform function that runs the
 * code sets it — to a literal, or to the name of a table resource the module declares.
 */
const files: Record<string, string> = {
  "infra/main.tf": `
resource "aws_dynamodb_table" "clubs" {
  name = "league-clubs"
}
resource "aws_dynamodb_table" "cars" {
  name = "\${var.prefix}-cars"
}
data "archive_file" "api" {
  source_dir = "\${path.module}/../src"
}
resource "aws_lambda_function" "clubs" {
  function_name = "clubs"
  handler       = "clubs.list"
  filename      = data.archive_file.api.output_path
  environment {
    variables = {
      CLUBS_TABLE = aws_dynamodb_table.clubs.name
    }
  }
}
resource "aws_lambda_function" "players" {
  function_name = "players"
  handler       = "players.list"
  filename      = data.archive_file.api.output_path
  environment {
    variables = { "PLAYERS_TABLE" = "players-prod", OTHER = "x" }
  }
}
resource "aws_lambda_function" "cars" {
  function_name = "cars"
  handler       = "cars.list"
  filename      = data.archive_file.api.output_path
  environment {
    variables = {
      CARS_TABLE = aws_dynamodb_table.cars.name
      STAGED_TABLE = var.staged
    }
  }
}
resource "aws_apigatewayv2_route" "clubs" {
  route_key = "GET /clubs"
  target    = "integrations/\${aws_apigatewayv2_integration.clubs.id}"
}
resource "aws_apigatewayv2_integration" "clubs" { integration_uri = aws_lambda_function.clubs.invoke_arn }
resource "aws_apigatewayv2_route" "players" {
  route_key = "GET /players"
  target    = "integrations/\${aws_apigatewayv2_integration.players.id}"
}
resource "aws_apigatewayv2_integration" "players" { integration_uri = aws_lambda_function.players.invoke_arn }
resource "aws_apigatewayv2_route" "cars" {
  route_key = "GET /cars"
  target    = "integrations/\${aws_apigatewayv2_integration.cars.id}"
}
resource "aws_apigatewayv2_integration" "cars" { integration_uri = aws_lambda_function.cars.invoke_arn }
`,
  "src/clubs.js": `const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
exports.list = async () => docClient.scan({ TableName: process.env.CLUBS_TABLE }).promise();
`,
  "src/players.js": `const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
exports.list = async () => docClient.scan({ TableName: process.env.PLAYERS_TABLE }).promise();
`,
  "src/cars.js": `const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
exports.list = async () => docClient.scan({ TableName: process.env.CARS_TABLE }).promise();
`,
};

describe("Terraform-set DynamoDB table variables", () => {
  let dir: string;
  let flows: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-tf-dynamo-"));
    const root = join(dir, "app");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const s = await loadReportSummary(out);
    flows = (s.dataFlows ?? []).map((p) => `${p.entryLabel} ${p.effect} ${p.resource}`).sort();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reaches a literal, and the literal name of a table resource", () => {
    expect(flows).toEqual(["GET /clubs db-read league-clubs", "GET /players db-read players-prod"]);
  });

  it("never guesses a table whose name is built from a variable", () => {
    expect(flows.some((f) => f.includes("/cars"))).toBe(false);
  });
});
