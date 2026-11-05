import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** `Astro.redirect('/x')` in a page: a page that only redirects is wiring; a guard leads on to its target. */
describe("Astro redirects", () => {
  let summary: ProjectAnalysis;
  let root: string;
  let out: string;
  const files: Record<string, string> = {
    "package.json": `{"name":"club-site","dependencies":{"astro":"4.0.0"}}`,
    "src/pages/index.astro": `---\nreturn Astro.redirect('/clubs');\n---\n`,
    "src/pages/clubs.astro": `---\nconst user = Astro.locals.user;\nif (!user) return Astro.redirect('/login');\n---\n<h1>Clubs</h1><a href="/about">About</a>\n`,
    "src/pages/login.astro": `---\n---\n<h1>Login</h1><form method="post" action="/api/login"><button>Go</button></form>\n`,
    "src/pages/about.astro": `---\n---\n<h1>About</h1><a href="/clubs">Clubs</a>\n`,
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-astro-redirect-src-"));
    out = mkdtempSync(join(tmpdir(), "clarifydoc-astro-redirect-out-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("reads a markup-less page as a redirect and a guarded one as leading on", () => {
    const rows = Object.fromEntries(summary.routeMap.map((r) => [r.path, { redirectTo: r.redirectTo, leadsTo: r.leadsTo?.map((l) => l.path) }]));
    expect(rows["/"]).toEqual({ redirectTo: "/clubs", leadsTo: undefined });
    expect(rows["/clubs"]).toEqual({ redirectTo: undefined, leadsTo: ["/login"] });
  });

  it("draws the guard's redirect in the navigation map", () => {
    const edges = (summary.screenFlow?.edges ?? []).map((e) => `${e.kind} ${e.via ?? ""}`);
    expect(edges.some((e) => e.startsWith("server-redirect"))).toBe(true);
  });
});
