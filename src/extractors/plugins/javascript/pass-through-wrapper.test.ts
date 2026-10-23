import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A service that forwards the URL its callers give it to the HTTP client (real-repo FP: 3 routes uncalled). */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web" }),
  "src/services/http.ts": `export const http = { silently: { get: (url: string) => fetch(url) } }\n`,
  "src/services/signedUrlService.ts": `import { http } from './http'
export const signedUrlService = {
  async fetch (endpoint: string) {
    return await http.silently.get(endpoint)
  },
}
`,
  "src/stores/stadiumStore.ts": `import { signedUrlService } from '@/services/signedUrlService'
export const stadiumStore = {
  async streamUrl (stadium: { id: number }) {
    return await signedUrlService.fetch(\`stadiums/\${stadium.id}/stream-url\`)
  },
}
`,
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
};

describe("a pass-through URL wrapper", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-pass-through-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives each caller the request with the URL it passes", () => {
    const calls = (summary.apiCalls ?? []).map((c) => `${c.filePath} ${c.name} ${c.target}`);
    expect(calls).toContain("src/stores/stadiumStore.ts get /stadiums/${stadium.id}/stream-url");
  });
});
