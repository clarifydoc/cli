import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * How a page is rendered, read from the framework's own settings: Next.js data functions and segment config,
 * SvelteKit page options through the layouts above, Nuxt `routeRules`. A component that merely spells the same
 * exports, and a page the framework leaves undecided, state no mode.
 */
const layout = "export default function L({ children }: any) { return <div>{children}</div> }\n";
const page = (name: string) => `export default function ${name}() { return <h1>${name}</h1> }\n`;
const vue = "<template><h1>Club</h1></template>\n";

const FILES: Record<string, string> = {
  // Next.js, pages router
  "next/package.json": JSON.stringify({ name: "club-next", dependencies: { next: "14.0.0", react: "18.0.0" } }),
  "next/pages/index.tsx": page("Home"),
  "next/pages/table.tsx": `${page("Table")}export async function getServerSideProps() { return { props: {} } }\n`,
  "next/pages/squad.tsx": `${page("Squad")}export const getStaticProps = async () => ({ props: {} })\n`,
  "next/pages/fixtures.tsx": `${page("Fixtures")}export async function getStaticProps() { return { props: {}, revalidate: 60 } }\n`,
  "next/pages/forward.tsx": "export { default } from '../lib/club-page'\n",
  "next/pages/notes.tsx": `${page("Notes")}// export async function getServerSideProps() { return { props: {} } }\n`,
  "next/lib/decoy.tsx": "export const revalidate = 30\nexport async function getStaticProps() { return { props: {}, revalidate: 5 } }\nexport function Decoy() { return <div /> }\n",
  // Next.js, app router
  "next/app/layout.tsx": layout,
  "next/app/shop/layout.tsx": `export const dynamic = 'force-dynamic'\n${layout}`,
  "next/app/shop/page.tsx": page("Shop"),
  "next/app/shop/[id]/page.tsx": `export const dynamic = 'force-static'\n${page("Car")}`,
  "next/app/blog/page.tsx": `export const revalidate = 120\n${page("Blog")}`,
  "next/app/plain/page.tsx": `export async function generateStaticParams() { return [] }\n${page("Plain")}`,
  "next/app/live/page.tsx": `'use client'\n${page("Live")}`,
  "next/app/helpers/Helper.tsx": "export const dynamic = 'force-dynamic'\nexport const revalidate = 10\nexport function Helper() { return <div /> }\n",
  // SvelteKit
  "kit/package.json": JSON.stringify({ name: "club-kit", devDependencies: { "@sveltejs/kit": "2.0.0", svelte: "4.0.0" } }),
  "kit/src/routes/+layout.ts": "export const ssr = false\nexport const prerender = false\n",
  "kit/src/routes/+page.svelte": "<h1>Home</h1>\n",
  "kit/src/routes/(app)/+layout.server.ts": "export const ssr = true\n",
  "kit/src/routes/(app)/table/+page.svelte": "<h1>Table</h1>\n",
  "kit/src/routes/(app)/table/+page.ts": "// export const prerender = true\nexport const csr = false\n",
  "kit/src/routes/marketing/+layout.ts": "export const prerender = true\n",
  "kit/src/routes/marketing/+page.svelte": "<h1>About</h1>\n",
  "kit/src/routes/plain/+page.svelte": "<h1>Plain</h1>\n",
  "kit/src/routes/plain/+page.ts": "export const ssr = true\nexport const prerender = false\n",
  "kit/src/lib/options.ts": "export const prerender = true\nexport const ssr = false\n",
  // Nuxt
  "nuxt/package.json": JSON.stringify({ name: "club-nuxt", dependencies: { nuxt: "3.10.0" } }),
  "nuxt/nuxt.config.ts": `export default defineNuxtConfig({
  routeRules: {
    '/': { prerender: true },
    '/blog/**': { isr: 3600 },
    '/blog/archive': { prerender: true },
    '/admin/**': { ssr: false },
    '/news': { swr: 600 },
    // '/table': { ssr: false },
  },
})
`,
  "nuxt/pages/index.vue": vue,
  "nuxt/pages/blog/index.vue": vue,
  "nuxt/pages/blog/[slug].vue": vue,
  "nuxt/pages/blog/archive.vue": vue,
  "nuxt/pages/admin/index.vue": vue,
  "nuxt/pages/news.vue": vue,
  "nuxt/pages/table.vue": vue,
  "nuxt/pages/about.vue": "<script setup>\ndefineRouteRules({ prerender: true })\n</script>\n<template><h1>About</h1></template>\n",
  "nuxt/components/Decoy.vue": "<script setup>\ndefineRouteRules({ ssr: false })\n</script>\n<template><p>decoy</p></template>\n",
};

describe("page rendering mode", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-render-mode-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const modes = (prefix: string) =>
    Object.fromEntries(
      summary.routeMap.filter((r) => r.kind === "frontend" && (r.filePath ?? "").startsWith(prefix)).map((r) => [r.path, r.renderMode ?? "none"]),
    );

  it("reads the Next.js pages router from the data functions", () => {
    const m = modes("next/pages/");
    expect(m["/table"]).toBe("ssr");
    expect(m["/squad"]).toBe("ssg");
    expect(m["/fixtures"]).toBe("isr");
    expect(m["/"]).toBe("csr");
    // A comment is no export, and a page forwarding its exports from elsewhere hides them.
    expect(m["/notes"]).toBe("csr");
    expect(m["/forward"]).toBe("none");
  });

  it("reads the Next.js app router segment config, the page's own before its layout's", () => {
    const m = modes("next/app/");
    expect(m["/shop"]).toBe("ssr");
    expect(m["/shop/:id"]).toBe("ssg");
    expect(m["/blog"]).toBe("isr");
    expect(m["/plain"]).toBe("ssg");
    // 'use client' is no page mode; a page without config is undecided.
    expect(m["/live"]).toBe("none");
  });

  it("puts the mode on the screen, and none on a file outside the page folders", () => {
    const screens = Object.fromEntries(summary.screens.filter((s) => s.filePath.startsWith("next/")).map((s) => [s.routePath, s.renderMode]));
    expect(screens["/table"]).toBe("ssr");
    expect(screens["/blog"]).toBe("isr");
    expect(screens["/live"]).toBeUndefined();
    expect(summary.routeMap.some((r) => (r.filePath ?? "").includes("decoy") || (r.filePath ?? "").includes("Helper"))).toBe(false);
    expect(summary.screens.filter((s) => s.filePath.includes("Decoy") || s.filePath.includes("Helper")).every((s) => !s.renderMode)).toBe(true);
  });

  it("reads SvelteKit page options through the layouts above the page", () => {
    const m = modes("kit/");
    expect(m["/"]).toBe("csr");
    expect(m["/table"]).toBe("ssr");
    expect(m["/marketing"]).toBe("ssg");
    expect(m["/plain"]).toBe("ssr");
  });

  it("reads Nuxt routeRules by pattern, the more specific rule last, and a page's own rule", () => {
    const m = modes("nuxt/");
    expect(m["/"]).toBe("ssg");
    expect(m["/blog"]).toBe("isr");
    expect(m["/blog/:slug"]).toBe("isr");
    expect(m["/blog/archive"]).toBe("ssg");
    expect(m["/admin"]).toBe("csr");
    expect(m["/news"]).toBe("isr");
    expect(m["/about"]).toBe("ssg");
    expect(m["/table"]).toBe("none");
    expect(summary.screens.filter((s) => s.filePath.includes("Decoy")).every((s) => !s.renderMode)).toBe(true);
  });
});
