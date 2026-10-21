import { describe, it, expect } from "vitest";
import { hclPath, hclRefs, hclString, parseHcl } from "./hcl.js";

describe("HCL reader", () => {
  it("reads blocks, labels, attributes as written and nested blocks, through comments, heredocs and interpolation", () => {
    const blocks = parseHcl(`
# a comment { not a block
terraform { required_version = ">= 1.5" }

resource "aws_lambda_function" "cars" {
  function_name = "cars-\${var.stage}"   // trailing comment
  handler       = "index.handler"
  filename      = data.archive_file.cars.output_path
  environment {
    variables = {
      QUEUE_URL = aws_sqs_queue.jobs.url
      TABLE     = "cars"
    }
  }
  policy = <<EOF
{ "Statement": [ { "Effect": "Allow" } ] }
EOF
  tags = { app = "shop" }
}

/* block comment
resource "x" "y" {} */
data "archive_file" "cars" {
  type        = "zip"
  source_dir  = "\${path.module}/../src/cars"
}
`);
    expect(blocks.map((b) => [b.type, b.labels.join(".")])).toEqual([["terraform", ""], ["resource", "aws_lambda_function.cars"], ["data", "archive_file.cars"]]);
    const fn = blocks[1]!;
    expect(fn.line).toBe(5);
    expect(hclString(fn.attrs.get("handler"))).toBe("index.handler");
    expect(hclString(fn.attrs.get("function_name"))).toBeNull();
    expect(hclRefs(fn.attrs.get("filename"))).toEqual([{ type: "data.archive_file", name: "cars", attr: "output_path" }]);
    expect(fn.blocks[0]!.type).toBe("environment");
    expect(hclRefs(fn.blocks[0]!.attrs.get("variables"))).toEqual([{ type: "aws_sqs_queue", name: "jobs", attr: "url" }]);
    expect(fn.attrs.get("tags")).toBe('{ app = "shop" }');
    expect(hclPath(blocks[2]!.attrs.get("source_dir"), "infra")).toBe("infra/../src/cars");
  });
});
