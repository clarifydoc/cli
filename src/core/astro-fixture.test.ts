import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * An Astro site: pages under `src/pages` are screens at their path, `.astro` components are imported and
 * used as tags, frontmatter and `<script>` code is read, and `src/pages/api/*.ts` exports HTTP-method handlers.
 */
describe("Astro site", () => {
  let summary: ProjectAnalysis;
  let root: string;
  let out: string;
  const files: Record<string, string> = {
    "package.json": `{"name":"club-site","dependencies":{"astro":"4.0.0"}}`,
    "src/layouts/Layout.astro": `---
const { title } = Astro.props;
---
<html><head><title>{title}</title></head><body><slot /></body></html>
`,
    "src/components/ClubCard.astro": `---
import { formatClub } from '../lib/format';
const { club } = Astro.props;
const label = formatClub(club);
---
<article><a href={\`/clubs/\${club.id}\`}>{label}</a></article>
`,
    "src/lib/format.ts": `export function formatClub(club: { name: string }) { return club.name.toUpperCase(); }\n`,
    "src/pages/index.astro": `---
import Layout from '../layouts/Layout.astro';
import ClubCard from '../components/ClubCard.astro';
const response = await fetch('/api/clubs');
const clubs = await response.json();
---
<Layout title="Clubs">
  <h1>Clubs</h1>
  {clubs.map((club) => <ClubCard club={club} />)}
  <a href="/about">About</a>
  <form method="post" action="/api/clubs"><input name="name" /><button type="submit">Add</button></form>
</Layout>
<script>
  document.querySelector('form')?.addEventListener('submit', () => { fetch('/api/clubs/refresh', { method: 'POST' }); });
</script>
`,
    "src/pages/about.astro": `---\n---\n<h1>About</h1><a href="/">Home</a>\n`,
    "src/pages/clubs/[id].astro": `---
import Layout from '../../layouts/Layout.astro';
const { id } = Astro.params;
---
<Layout title="Club"><p>{id}</p></Layout>
`,
    // an underscore prefix keeps a file out of the routes
    "src/pages/_draft.astro": `---\n---\n<h1>Draft</h1><a href="/about">About</a>\n`,
    "src/pages/api/clubs.ts": `import type { APIRoute } from 'astro';
export const GET: APIRoute = async () => new Response(JSON.stringify([]));
export const POST: APIRoute = async ({ request }) => { const data = await request.formData(); return new Response(null, { status: 201 }); };
`,
    "src/pages/api/clubs/refresh.ts": `export async function POST() { return new Response(null, { status: 204 }); }\n`,
    "src/pages/api/_helpers.ts": `export const GET = () => new Response('not a route');\n`,
    // a namesake outside src/pages is no page
    "src/components/about.ts": `export function GET() { return 1; }\n`,
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-astro-src-"));
    out = mkdtempSync(join(tmpdir(), "clarifydoc-astro-out-"));
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

  it("discovers .astro files and reads their frontmatter imports", () => {
    expect(summary.files).toEqual(expect.arrayContaining(["src/pages/index.astro", "src/components/ClubCard.astro", "src/layouts/Layout.astro"]));
    const edges = summary.componentGraph["src/pages/index.astro"] ?? [];
    expect(edges).toEqual(expect.arrayContaining(["src/layouts/Layout.astro", "src/components/ClubCard.astro"]));
    expect(summary.componentGraph["src/components/ClubCard.astro"]).toContain("src/lib/format.ts");
  });

  it("serves each page at its path as a screen, and no underscore file", () => {
    const pages = Object.fromEntries((summary.screens ?? []).filter((s) => s.routePath).map((s) => [s.filePath, s.routePath]));
    expect(pages).toEqual({
      "src/pages/index.astro": "/",
      "src/pages/about.astro": "/about",
      "src/pages/clubs/[id].astro": "/clubs/:id",
    });
  });

  it("makes a route of each exported HTTP-method handler, not of helpers or namesakes", () => {
    const api = summary.routeMap.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.filePath}`).sort();
    expect(api).toEqual([
      "GET /api/clubs src/pages/api/clubs.ts",
      "POST /api/clubs src/pages/api/clubs.ts",
      "POST /api/clubs/refresh src/pages/api/clubs/refresh.ts",
    ]);
  });

  it("joins the page's fetch, form and script requests to those routes", () => {
    const rows = (summary.apiRouteLinks ?? []).filter((l) => l.source === "src/pages/index.astro").map((l) => `${l.method} ${l.url} -> ${l.routePath}`).sort();
    expect(rows).toEqual(["GET /api/clubs -> /api/clubs", "POST /api/clubs -> /api/clubs", "POST /api/clubs/refresh -> /api/clubs/refresh"]);
  });

  it("shows the component tags and link targets on the screen", () => {
    const index = (summary.screens ?? []).find((s) => s.filePath === "src/pages/index.astro")!;
    expect(index.formType).toBe("AstroPage");
    expect(JSON.stringify(index.components)).toContain("ClubCard");
    expect(index.navigatesTo).toEqual(expect.arrayContaining(["/about"]));
  });
});
