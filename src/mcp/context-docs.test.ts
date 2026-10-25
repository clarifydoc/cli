/**
 * clarifydoc_context_docs: decision records, framing documents and declared
 * ones listed, searched and read only from that list; the files a document
 * names, and which of them were committed after it; decision markers in the
 * code; and the same per file in clarifydoc_file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

let dir = "";
const proj = () => join(dir, "proj");

function git(args: string[], date: string): void {
  execFileSync("git", ["-c", "user.name=Coach", "-c", "user.email=coach@example.com", "-C", proj(), ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "ignore",
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-context-docs-"));
  await cp(resolve("test-fixtures/sample-backend"), proj(), { recursive: true });
  await cp(resolve("test-output/sample-backend"), join(dir, "out"), { recursive: true });
  const put = async (path: string, text: string) => {
    await mkdir(join(proj(), path, ".."), { recursive: true });
    await writeFile(join(proj(), path), text);
  };
  await put("docs/adr/0001-player-store.md", "# Players live in Postgres\n\nStatus: Accepted\n\nThe player service (`services/playerService.ts`) queries Prisma directly.\n");
  await put("docs/adr/0002-auth-tokens.md", "# Tokens, not sessions\n\n## Status\n\nSuperseded by 0003\n\nSee services/authService.ts.\n");
  await put("ARCHITECTURE.md", "# Club backend\n\nRoutes call services; services call the database.\n");
  await put("notes/match-rules.md", "# Match rules\n\nA match has two clubs.\n");
  await put(".clarifydoc/config.json", JSON.stringify({ context: [{ path: "notes/match-rules.md", description: "before changing scoring" }, { path: "../outside.md" }] }));
  await appendFile(join(proj(), "services", "authService.ts"), "\n// WHY: tokens expire after a match day so a stolen one dies quickly\n");
  git(["init", "-q"], "2026-01-01T10:00:00Z");
  git(["add", "-A"], "2026-01-01T10:00:00Z");
  git(["commit", "-q", "-m", "club backend"], "2026-01-01T10:00:00Z");
  await appendFile(join(proj(), "services", "playerService.ts"), "\nexport const transfers = 1;\n");
  git(["commit", "-q", "-am", "transfers"], "2026-03-01T10:00:00Z");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: join(dir, "out"), allowAnalyze: false, allowColdStart: false, log: () => {} });
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: res.result.content[0]!.text, isError: res.result.isError === true };
}

describe("clarifydoc_context_docs", () => {
  it("lists decision records first, with their status, the files they name and whether those moved on", async () => {
    const { text } = await call("clarifydoc_context_docs");
    const rows = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(rows.map((r) => r.slice(0, r.indexOf(" — ")))).toEqual([
      "- [decision] Players live in Postgres",
      "- [decision] Tokens, not sessions",
      "- [context] Club backend",
      "- [context] Match rules",
    ]);
    expect(text.split("\n")[0]).toBe("# Context documents (4) — 1 may be stale");
    expect(rows[0]).toContain("docs/adr/0001-player-store.md · Accepted · names 1 analyzed file; 1 committed after it (2026-01-01): services/playerService.ts (2026-03-01) — it may be stale");
    expect(rows[1]).toContain("· Superseded by 0003 · names 1 analyzed file, none changed since it was written");
    expect(rows[3]).toContain("notes/match-rules.md — before changing scoring");
    expect(text).toMatch(/## Decision markers in code \(1\)\n- WHY: tokens expire after a match day so a stolen one dies quickly \(services\/authService\.ts:\d+\)/);
  });

  it("searches with every term, reads only a listed document, and answers per file", async () => {
    const found = (await call("clarifydoc_context_docs", { query: "prisma player" })).text;
    expect(found).toMatch(/- \[decision\] Players live in Postgres — docs\/adr\/0001-player-store\.md[^\n]*\n {2}- L1: # Players live in Postgres\n {2}- L5: The player service/);
    expect(found).not.toContain("Tokens, not sessions");
    expect((await call("clarifydoc_context_docs", { query: "stolen" })).text).toContain("WHY: tokens expire");

    const read = (await call("clarifydoc_context_docs", { path: "docs/adr/0001-player-store.md" })).text;
    expect(read).toMatch(/^# Players live in Postgres \(docs\/adr\/0001-player-store\.md\)\nstatus: Accepted\n.*may be stale\nfiles it names: services\/playerService\.ts\n\n````?markdown\n# Players live in Postgres/);
    for (const path of ["services/authService.ts", "../out/project-summary.json", "/etc/passwd", "../outside.md"]) {
      expect((await call("clarifydoc_context_docs", { path })).isError, path).toBe(true);
    }

    const about = (await call("clarifydoc_context_docs", { file: "services/authService.ts" })).text;
    expect(about).toContain("## Documents naming it (1)\n- [decision] Tokens, not sessions");
    expect(about).toContain("## Decision markers in it (1)\n- WHY: tokens expire");
  });

  it("puts the same in clarifydoc_file, and a count in clarifydoc_status", async () => {
    const file = (await call("clarifydoc_file", { path: "services/playerService.ts", sections: ["decisions"] })).text;
    expect(file).toMatch(/## Decisions\n- \[decision\] Players live in Postgres — docs\/adr\/0001-player-store\.md · Accepted · names 1 analyzed file; 1 committed after it/);
    const status = (await call("clarifydoc_status")).text;
    expect(status).toMatch(/context docs: decision records: 2, context documents: 2 \(1 may be stale\) — clarifydoc_context_docs/);
  });
});
