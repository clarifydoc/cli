import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * Two small shapes of the screen to route chain: an Angular `httpResource` request, and a module whose
 * default export is an async wrapper of a dynamic import, used by a page.
 */
describe("Angular httpResource requests join their routes", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-httpres-"));
    const root = join(dir, "league");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league", dependencies: { "@angular/core": "19.0.0", "@angular/common": "19.0.0", express: "4.18.0" } }));
    await writeFile(join(root, "server", "app.js"), [
      "const app = require('express')();",
      "app.get('/api/clubs', (req, res) => res.json([]));",
      "app.get('/api/clubs/:id', (req, res) => res.json({}));",
      "app.post('/api/transfers', (req, res) => res.json({}));",
      "app.get('/api/report', (req, res) => res.send(''));",
      "app.get('/api/garages', (req, res) => res.json([]));",
    ].join("\n"));
    await writeFile(join(root, "src", "clubs.component.ts"), [
      "import { Component, signal } from '@angular/core';",
      "import { httpResource } from '@angular/common/http';",
      "@Component({ selector: 'app-clubs', template: '<ul></ul>' })",
      "export class ClubsComponent {",
      "  id = signal(1);",
      "  clubs = httpResource<Club[]>(() => '/api/clubs');",
      "  club = httpResource(() => `/api/clubs/${this.id()}`);",
      "  transfer = httpResource(() => ({ url: '/api/transfers', method: 'POST' }));",
      "  transfer2 = httpResource({ url: '/api/transfers', method: 'POST' });",
      "  report = httpResource.text(() => '/api/report');",
      "}",
    ].join("\n"));
    // The same name from another package states nothing.
    await writeFile(join(root, "src", "garages.ts"), [
      "import { httpResource } from './own-http';",
      "export const garages = httpResource(() => '/api/garages');",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records each form as an api-call at its URL and method, and links the routes", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = (summary.apiRouteLinks ?? []).map((l) => `${l.method} ${l.routePath}`).sort();
    expect(links).toEqual(["GET /api/clubs", "GET /api/clubs/:id", "GET /api/report", "POST /api/transfers", "POST /api/transfers"]);
  });
});

describe("an async wrapper re-exported as default resolves to the component it loads", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-asyncdefault-"));
    const root = join(dir, "league");
    await mkdir(join(root, "src", "components"), { recursive: true });
    await mkdir(join(root, "src", "views"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league", dependencies: { vue: "3.4.0", "vue-router": "4.2.0", axios: "1.6.0" } }));
    const card = (name: string, fn: string, path: string) => [
      `<template><button @click="${fn}">${name}</button></template>`,
      "<script setup>",
      "import axios from 'axios'",
      `function ${fn}() { axios.post('${path}', {}) }`,
      "</script>",
    ].join("\n");
    await writeFile(join(root, "src", "components", "ClubCard.vue"), card("Club", "saveClub", "/api/clubs"));
    await writeFile(join(root, "src", "components", "SponsorCard.vue"), card("Sponsor", "saveSponsor", "/api/sponsors"));
    await writeFile(join(root, "src", "components", "AsyncCard.ts"), [
      "import { defineAsyncComponent } from 'vue'",
      "export default defineAsyncComponent(() => import('./ClubCard.vue'))",
    ].join("\n"));
    // Same helper name and the same default-export shape, another component, used by another page.
    await mkdir(join(root, "src", "sponsors"), { recursive: true });
    await writeFile(join(root, "src", "sponsors", "AsyncCard.ts"), [
      "import { createAsyncComponent } from '../helpers'",
      "export default createAsyncComponent(() => import('../components/SponsorCard.vue'))",
    ].join("\n"));
    await writeFile(join(root, "src", "views", "ClubsView.vue"), [
      "<template><div><AsyncCard /></div></template>",
      "<script setup>",
      "import AsyncCard from '../components/AsyncCard'",
      "</script>",
    ].join("\n"));
    await writeFile(join(root, "src", "views", "SponsorsView.vue"), [
      "<template><div><AsyncCard /></div></template>",
      "<script setup>",
      "import AsyncCard from '../sponsors/AsyncCard'",
      "</script>",
    ].join("\n"));
    await writeFile(join(root, "src", "router.ts"), [
      "import { createRouter } from 'vue-router'",
      "export default createRouter({ routes: [",
      "  { path: '/clubs', component: () => import('./views/ClubsView.vue') },",
      "  { path: '/sponsors', component: () => import('./views/SponsorsView.vue') },",
      "] })",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives the page a reference to the loaded component, never to a namesake wrapper's", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const refs = (summary.symbolLinks ?? []).filter((l) => l.relation === "reference").map((l) => `${l.sourceFile} -> ${l.targetFile}`);
    expect(refs).toContain("src/views/ClubsView.vue -> src/components/ClubCard.vue");
    expect(refs).toContain("src/views/SponsorsView.vue -> src/components/SponsorCard.vue");
    expect(refs).not.toContain("src/views/ClubsView.vue -> src/components/SponsorCard.vue");
    expect(refs).not.toContain("src/views/SponsorsView.vue -> src/components/ClubCard.vue");
  });
});
