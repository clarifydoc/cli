import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { gunzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";
import { generateHtmlReport, encodeReportPayload, renderReportFromTemplate } from "../html-report.js";
import { DEFERRED_FIELDS, buildReportPayload } from "../report-payload.js";
import type { ProjectAnalysis } from "../../types/analysis.js";

// End-to-end smoke test for the standalone report: the React viewer template
// (built by `npm run build:viewer`, committed under html-report/viewer-assets/)
// with the payload injected as gzip+base64 into the #clarifydoc-data tag.

const MINIMAL_SUMMARY = {
  projectRoot: "/tmp/demo",
  analyzedAt: new Date(0).toISOString(),
  detectedFrameworks: [],
  files: [],
  routeMap: [],
  apiCalls: [],
};

async function generate(dir: string): Promise<string> {
  await writeFile(join(dir, "project-summary.json"), JSON.stringify(MINIMAL_SUMMARY), "utf-8");
  const outPath = join(dir, "report.html");
  await generateHtmlReport({ analysisDir: dir, outputPath: outPath, openBrowser: false });
  return readFile(outPath, "utf-8");
}

/** Mirrors standalone.tsx's decoder: base64 → gunzip → JSON. */
function extractPayload(html: string): Record<string, unknown> {
  const m = html.match(
    /<script id="clarifydoc-data" type="application\/gzip-base64\+json">([\s\S]*?)<\/script>/,
  );
  expect(m).not.toBeNull();
  return JSON.parse(gunzipSync(Buffer.from(m![1], "base64")).toString("utf8"));
}

describe("generateHtmlReport — standalone template", () => {
  let dir: string;
  let html: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-report-"));
    html = await generate(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits a complete HTML document with no leftover tokens", () => {
    expect(html.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // The renderer substitutes exactly these placeholders; neither may remain.
    // (Not a blanket `__CLARIFYDOC_` check — the viewer has a legitimate runtime
    // global `window.__CLARIFYDOC_HASH__` for editor deep-linking.)
    expect(html).not.toContain("__CLARIFYDOC_TITLE__");
    expect(html).not.toContain("__CLARIFYDOC_PAYLOAD__");
  });

  it("replaces the title with the project name", () => {
    expect(html).toContain("<title>ClarifyDoc — demo</title>");
  });

  it("embeds a decodable payload that matches report-data.json", async () => {
    const embedded = extractPayload(html);
    expect(embedded.projectName).toBe("demo");
    expect(embedded.deferredFields).toEqual([...DEFERRED_FIELDS]);
    const onDisk = JSON.parse(await readFile(join(dir, "report-data.json"), "utf-8"));
    expect(embedded).toEqual(onDisk);
  });

  it("is fully self-contained (no CDN scripts)", () => {
    expect(html).not.toContain("cdnjs.cloudflare.com");
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
  });
});

describe("encodeReportPayload — hostile payload content", () => {
  const nasty = {
    script: "</script><script>alert(1)</script>",
    comment: "<!-- sneaky -->",
    backtick: "a`b${c}`d",
    dollar: "cost is $& and $' and $` and $$",
    separators: "a b c",
  };

  it("emits pure base64 — nothing that can terminate the script tag", () => {
    const b64 = encodeReportPayload(nasty);
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("round-trips through gunzip unchanged", () => {
    const back = JSON.parse(gunzipSync(Buffer.from(encodeReportPayload(nasty), "base64")).toString("utf8"));
    expect(back).toEqual(nasty);
  });

  it("survives template injection intact (incl. $-replacement patterns)", async () => {
    const payload = buildReportPayload({
      ...MINIMAL_SUMMARY,
      projectRoot: "/tmp/demo",
      files: [nasty.script, nasty.dollar, nasty.backtick, nasty.comment, nasty.separators],
    } as unknown as ProjectAnalysis);
    const html = await renderReportFromTemplate(payload);
    const embedded = extractPayload(html) as { files: string[] };
    expect(embedded.files).toEqual(payload.files);
  });
});
