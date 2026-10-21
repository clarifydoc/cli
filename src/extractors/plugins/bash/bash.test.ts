import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "scripts/run.sh"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "bash-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "bash-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "bash" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("Bash functions and calls", () => {
  it("reads both function forms and their commands — never builtins or keywords", async () => {
    const a = await analyze([
      "set -euo pipefail",
      "deploy() {",
      "  local env=\"$1\"",
      "  if [[ -z \"$env\" ]] && ! confirm \"go?\"; then return 1; fi",
      "  result=$(get_status \"$env\")",
      "  sudo docker compose up -d",
      "  echo done",
      "}",
      "function rollback { notify ops; }",
      "deploy \"${1:-staging}\"",
    ].join("\n"));
    const fns = Object.fromEntries(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)]));
    expect(fns).toEqual({ "<setup>": ["deploy"], deploy: ["confirm", "get_status", "docker"], rollback: ["notify"] });
    // 1 + the `if` + the `&&` in its condition
    expect(a.complexities?.find((c) => c.functionName === "deploy")?.complexity).toBe(3);
  });
});

describe("Bash imports", () => {
  it("loads sourced files, anchored on the script's directory or not, and records scripts it runs", async () => {
    const a = await analyze([
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'source "$DIR/../lib/common.sh"',
      '. "$(dirname "$0")/helpers.sh"',
      "source lib/env.sh",
      "./scripts/build.sh --release",
      "bash tools/lint.sh",
      'source "$HOME/.profile"',
    ].join("\n"));
    expect(a.imports.map((i) => `${i.source}${i.executes ? " (run)" : ""}`)).toEqual([
      "../lib/common.sh", "./helpers.sh", "lib/env.sh", "scripts/build.sh (run)", "tools/lint.sh (run)",
    ]);
  });
});

describe("Bash data access", () => {
  it("reads HTTP clients, a URL's base variable kept apart", async () => {
    const a = await analyze([
      'curl -sf -X POST "$API_URL/api/releases/$env"',
      'curl -d "{}" "${HOOK_URL:-http://x}/services/hooks"',
      "wget --post-data='x=1' https://example.com/api/form",
      "http PUT localhost:3000/api/items name=x",
      "curl -I https://example.com/health",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.name}${d.baseEnv ? ` (${d.baseEnv})` : ""}`)).toEqual([
      "POST /api/releases/{env} (API_URL)",
      "POST /services/hooks (HOOK_URL)",
      "POST https://example.com/api/form",
      "HEAD https://example.com/health",
    ]);
  });

  it("skips the value of a flag that takes one", async () => {
    const a = await analyze([
      'curl -s -o /dev/null -w "%{http_code}" -H "Accept: application/json" "$API/api/health"',
      "wget -O /tmp/out.json https://example.com/api/export",
      "curl -O https://example.com/files/a.tgz",
    ].join("\n"));
    expect(a.dataSources.map((d) => d.name)).toEqual([
      "GET /api/health",
      "GET https://example.com/api/export",
      "GET https://example.com/files/a.tgz",
    ]);
  });

  it("reads SQL given to database clients — operands, here-documents, through docker — and no prose", async () => {
    const a = await analyze([
      'psql "$DATABASE_URL" -c "INSERT INTO deploys (env) VALUES (\'prod\')"',
      "cat <<SQL | sqlite3 cache.db",
      "DELETE FROM sessions WHERE expired = 1;",
      "UPDATE stats SET n = 0;",
      "SQL",
      'docker exec db mysql -e "SELECT id FROM cars"',
      'echo "Select a file from disk"',
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.name} ${d.entity}@${d.line}`)).toEqual([
      "INSERT INTO deploys@1", "DELETE FROM sessions@3", "UPDATE stats@4", "SELECT cars@6",
    ]);
  });
});
