import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A folder `.clarifydocignore` names is out of every reader, not only the source walk: its compose file, Kubernetes
 * manifest, Terraform, CI pipeline and Markdown never become containers, queues, deploy steps or doc findings.
 * (A checked-out copy of another tool's repository beside the project used to put its whole stack on the map.)
 */
const FILES: Record<string, string> = {
  ".clarifydocignore": "/reference/\n",
  "docker-compose.yml": [
    "services:",
    "  league-api:",
    "    build: ./api",
    "    depends_on: [league-db]",
    "  league-db:",
    "    image: postgres:16",
    "",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", version: "1.0.0", main: "index.js" }),
  "api/index.js": "const http = require('http');\nhttp.createServer((req, res) => res.end('ok')).listen(3000);\n",
  // The ignored copy of another team's stack.
  "reference/stack/docker-compose.yml": [
    "services:",
    "  coach-server:",
    "    image: ghcr.io/example/coach-server:1",
    "  coach-web:",
    "    image: ghcr.io/example/coach-web:1",
    "    depends_on: [coach-server]",
    "",
  ].join("\n"),
  "reference/k8s/stand.yaml": [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: grandstand",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: grandstand",
    "          image: ghcr.io/example/grandstand:2",
    "",
  ].join("\n"),
  "reference/infra/main.tf": 'resource "aws_sqs_queue" "ticket_office" {\n  name = "ticket-office"\n}\n',
  "reference/.gitlab-ci.yml": "deploy:\n  stage: deploy\n  script:\n    - docker build -t turnstile .\n    - docker push turnstile\n",
  "reference/README.md": "# Turnstile\n\nSee `src/turnstile/gate.ts` and `GET /api/turnstiles`.\n",
};

describe("an ignored folder stays out of every reader", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ignored-folders-"));
    const root = join(dir, "league");
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 240_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the project's own stack", () => {
    const services = (summary.deployment?.services ?? []).map((s) => s.name).sort();
    expect(services).toEqual(["league-api", "league-db"]);
  });

  it("never names the ignored folder or what it declares", () => {
    const text = JSON.stringify(summary);
    expect(text).not.toContain("reference/");
    for (const name of ["coach-server", "coach-web", "grandstand", "ticket-office", "ticket_office", "turnstile"]) {
      expect(text, name).not.toContain(name);
    }
  });
});
