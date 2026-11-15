import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * `summary-head.json` is the extension's summarize() view of one analysis —
 * health, the twelve counts, frameworks — written beside the full summary so
 * a status bar never parses megabytes of JSON. With no LSP delta the in-memory
 * summary IS the view the extension would read; with one, the head goes through
 * loadReportSummary — the same delta merge the extension applies — so it must
 * agree with what the extension would compute from the artifacts in both cases.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const SETTINGS = { lsp: false, gitHistory: false, stableOutput: true, pretty: true } as const;

/** A tiny league app: a two-file frontend, its manifest and a README.
 * Committed, because a run is only ever judged up to date inside a git repository. */
async function writeGround(root: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  const web = join(root, "web");
  await mkdir(web, { recursive: true });
  await writeFile(
    join(web, "matches.ts"),
    `export async function listMatches(): Promise<unknown[]> {\n  const res = await fetch("/api/matches");\n  return res.json();\n}\n`,
  );
  await writeFile(
    join(web, "clubs.ts"),
    `import { listMatches } from "./matches";\n\nexport async function clubs(): Promise<unknown[]> {\n  const res = await fetch("/api/clubs");\n  return [...(await res.json()), ...(await listMatches())];\n}\n`,
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "ground", private: true }, null, 2) + "\n");
  await writeFile(join(root, "README.md"), "The league ground.\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "first");
}

interface Run {
  head: any;
  summary: any;
  headText: string;
  summaryText: string;
}

async function readHeadAndSummary(out: string): Promise<Run> {
  const [headText, summaryText] = await Promise.all([
    readFile(join(out, "summary-head.json"), "utf-8"),
    readFile(join(out, "project-summary.json"), "utf-8"),
  ]);
  return { head: JSON.parse(headText), summary: JSON.parse(summaryText), headText, summaryText };
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** Every field summarize() reads from the arrays: the head's counts must equal them. */
function expectParity(head: any, summary: any): void {
  expect(head.counts.files).toBe(len(summary.files));
  expect(head.counts.routes).toBe(len(summary.routeMap));
  expect(head.counts.links).toBe(len(summary.linkGraph));
  expect(head.counts.traces).toBe(len(summary.symbolLinks));
  expect(head.counts.screens).toBe(len(summary.screens));
  expect(head.counts.apiCalls).toBe(len(summary.apiCalls));
  expect(head.counts.entities).toBe(len(summary.entityGraph?.entities) || len(summary.entityGraph?.nodes) || 0);
  expect(head.counts.security).toBe(len(summary.securityIssues));
  expect(head.counts.suggestions).toBe(len(summary.suggestions));
  expect(head.counts.subProjects).toBe(len(summary.subProjects));
  expect(head.counts.layerViolations).toBe(len(summary.layerViolations));
  expect(head.counts.duplicates).toBe(len(summary.duplicates));
}

async function runGround(): Promise<{ out: string; ground: string }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-head-"));
  dirs.push(dir);
  const ground = join(dir, "ground");
  await writeGround(ground);
  const out = join(dir, "out");
  await analyze({ ...SETTINGS, projectRoot: ground, outputDir: out, incremental: true });
  return { out, ground };
}

describe("summary-head.json", () => {
  it("is written beside project-summary.json, and rewritten when a run finds nothing changed", async () => {
    const { out, ground } = await runGround();
    expect(existsSync(join(out, "project-summary.json"))).toBe(true);
    expect(existsSync(join(out, "summary-head.json"))).toBe(true);

    // Delete the head: an up-to-date run must rewrite it. This also covers the
    // backfill case — an analysis dir written by a build that predates the file.
    await rm(join(out, "summary-head.json"), { force: true });
    const second = await analyze({ ...SETTINGS, projectRoot: ground, outputDir: out, incremental: true });
    expect(second.upToDate).toBe(true);
    expect(existsSync(join(out, "summary-head.json"))).toBe(true);
  }, 60_000);

  it("a docs-only re-run rewrites the head, which the code change skipped", async () => {
    const { out, ground } = await runGround();
    await rm(join(out, "summary-head.json"), { force: true });
    // Only the committed README changes: the code fingerprint matches, the full
    // one does not, and no analyzed file changed — the docs-only path.
    await writeFile(join(ground, "README.md"), "The league ground: `web` and its API.\n");
    const second = await analyze({ ...SETTINGS, projectRoot: ground, outputDir: out, incremental: true });
    expect(second.docsOnly).toBe(true);
    const { head, summary } = await readHeadAndSummary(out);
    expect(head.schemaVersion).toBe(1);
    expect(head.analyzedAt).toBe(summary.analyzedAt);
  }, 60_000);

  it("carries the summary's identity, frameworks and health", async () => {
    const { out } = await runGround();
    const { head, summary } = await readHeadAndSummary(out);
    expect(head.schemaVersion).toBe(1);
    expect(head.projectRoot).toBe(summary.projectRoot);
    expect(head.analyzedAt).toBe(summary.analyzedAt);
    expect(head.frameworks.map((f: any) => f.name)).toEqual((summary.detectedFrameworks ?? []).map((f: any) => f.name));
    if (summary.healthScore) {
      expect(head.health).toEqual({ score: summary.healthScore.score, grade: summary.healthScore.grade });
    } else {
      expect(head.health).toBeUndefined();
    }
  }, 60_000);

  it("counts equal the arrays the extension's summarize() reads", async () => {
    const { out } = await runGround();
    const { head, summary } = await readHeadAndSummary(out);
    expectParity(head, summary);
    // Real, not vacuous: the project calls its own API and has analyzed files.
    expect(head.counts.apiCalls).toBeGreaterThan(0);
    expect(head.counts.files).toBeGreaterThan(0);
  }, 60_000);

  it("is a few kilobytes, not the summary", async () => {
    const { out } = await runGround();
    const { headText, summaryText } = await readHeadAndSummary(out);
    const headBytes = Buffer.byteLength(headText);
    const summaryBytes = Buffer.byteLength(summaryText);
    expect(headBytes).toBeGreaterThan(0);
    expect(headBytes).toBeLessThan(16 * 1024);
    expect(headBytes).toBeLessThan(summaryBytes);
  }, 60_000);

  it("a stale LSP delta's carried links reach the head, not the base summary", async () => {
    const { out, ground } = await runGround();
    const { summary: base } = await readHeadAndSummary(out);
    const baseTraces = len(base.symbolLinks);

    // A `lsp-update` from before this analysis: its delta predates the summary
    // (1969 predates the stable 1970 timestamp), and its added link — one the
    // text linker never drew — survives only where both files still hash the same.
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf-8"));
    const keys = Object.keys(manifest.entries).filter((k) => /clubs\.ts|matches\.ts$/.test(k));
    expect(keys).toHaveLength(2);
    const files: Record<string, string> = {};
    for (const k of keys) files[k] = manifest.entries[k].sha256;
    const [clubs, matches] = [keys.find((k) => k.includes("clubs"))!, keys.find((k) => k.includes("matches"))!];
    await writeFile(
      join(out, "lsp-enhancement.json"),
      JSON.stringify({
        symbolLinks: base.symbolLinks,
        componentGraph: base.componentGraph ?? {},
        linkGraph: base.linkGraph ?? [],
        blastRadius: [],
        lspStats: { source: "docker", serversUsed: [], lspResolvedCount: 1, referenceLinksCount: 0, enhancementTimeMs: 1 },
        enhancedAt: "1969-12-31T00:00:00.000Z",
        added: {
          links: [
            {
              sourceFile: clubs,
              sourceSymbol: "clubs",
              sourceLine: 4,
              callName: "kickoff",
              targetFile: matches,
              targetSymbol: "listMatches",
              targetLine: 1,
              resolvedBy: "lsp",
              confidence: "inferred",
            },
          ],
          files,
        },
      }),
    );

    const second = await analyze({ ...SETTINGS, projectRoot: ground, outputDir: out, incremental: true });
    expect(second.upToDate).toBe(true);
    const { head, summary } = await readHeadAndSummary(out);
    // The on-disk summary stands unchanged — analyze neither refreshes nor
    // removes the delta — but the head is the merged view: base + the carried link.
    expect(len(summary.symbolLinks)).toBe(baseTraces);
    expect(head.counts.traces).toBe(baseTraces + 1);
    expectParity(head, { ...summary, symbolLinks: [...(summary.symbolLinks ?? []), "carried"] });
  }, 60_000);
});
