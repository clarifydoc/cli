import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Classic page scripts calling helpers another script defines, a wrapper of a
 * wrapper of fetch (real-repo FP: 15 admin calls, 0 api-calls).
 */
const FILES: Record<string, string> = {
  "static/assets/admin.js": `"use strict";
const BASE_URL = window.location.origin;

function _fetch(method, url, successMsg, body) {
    fetch(url, { method: method, body: body }).then((resp) => resp.ok && alert(successMsg));
}

function _post(url, successMsg, body) {
    return _fetch("POST", url, successMsg, body);
}

function _delete(url, successMsg) {
    return _fetch("DELETE", url, successMsg);
}
`,
  "static/assets/admin_clubs.js": `"use strict";

function deleteClub(id) {
    _post(\`\${BASE_URL}/admin/clubs/\${id}/delete\`, "Club deleted");
}

function removeCoach(id) {
    _delete(\`\${BASE_URL}/admin/clubs/\${id}/coach\`, "Coach removed");
}
`,
};

describe("a wrapper of a wrapper of a request, in classic scripts", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-wrapper-chain-"));
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

  it("gives each page call its request", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath === "static/assets/admin_clubs.js").map((c) => `${c.name} ${c.target}`).sort();
    expect(calls).toEqual(["DELETE /admin/clubs/${id}/coach", "POST /admin/clubs/${id}/delete"]);
  });
});

/**
 * A wrapper whose request goes through an injected implementation, one imported under another
 * name beside a same-named decoy, and a base-and-path joiner that folds the leading slash.
 */
const INDEX_FILES: Record<string, string> = {
  "server/app.js": `const express = require('express');
const app = express();
app.get('/api/clubs', (req, res) => res.json([]));
app.get('/api/clubs/:id', (req, res) => res.json({}));
app.get('/api/players', (req, res) => res.json([]));
module.exports = app;
`,
  "src/injected.ts": `export function makeClient(opts: { impl?: typeof fetch }) {
  const impl = opts.impl ?? globalThis.fetch;
  return function request(path: string, init?: RequestInit) {
    return impl(path, init);
  };
}
export class ClubApi {
  private fetchImpl: typeof fetch;
  constructor(options: { fetch?: typeof fetch }) {
    this.fetchImpl = options.fetch || window.fetch;
  }
  send(url: string) { return this.fetchImpl(url); }
}
export const viaField = () => new ClubApi({}).send('/api/players');
`,
  "src/clubs.ts": `import { request as send } from './http-real';
export const loadClubs = () => send('/api/clubs');
export const loadClub = (id: string) => send(\`/api/clubs/\${id}\`);
`,
  "src/http-real.ts": `export function request(url: string) { return fetch(url); }
`,
  "src/decoy.ts": `export function request(url: string) { return fetch(\`/api/decoy\${url}\`); }
`,
  "src/fold.ts": `const BASE = '/api';
const url = (p: string) => \`\${BASE}\${p.startsWith('/') ? '' : '/'}\${p}\`;
export const a = () => fetch(url('clubs'));
export const b = () => fetch(url('/clubs/1'));
`,
  "src/negated.ts": `const join = (p: string) => \`/api\${!p.startsWith('/') ? '/' : ''}\${p}\`;
export const c = () => fetch(join('players'));
`,
  "src/cache.ts": `export function warm(cache: any, loader: any) {
  const load = cache.fetch || loader.fetch;
  return load('/api/players');
}
`,
  "src/other-fold.ts": `const url = (p: string) => \`/decoy-base/\${p}\`;
export const decoyUrl = () => fetch(url('clubs'));
`,
};

describe("wrapper lookups follow the import, not the bare name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-wrapper-index-"));
    for (const [rel, text] of Object.entries(INDEX_FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const rowsOf = (file: string) => (summary.apiCalls ?? []).filter((c) => c.filePath === file).map((c) => `${c.name} ${c.target}`).sort();

  it("reads a fetch bound through ?? or || as the wrapper's request, and fills its call sites", () => {
    expect((summary.apiCalls ?? []).some((c) => c.filePath === "src/injected.ts" && c.target === "${path}")).toBe(true);
    expect(rowsOf("src/injected.ts")).toContain("fetch /api/players");
  });

  it("fills a wrapper imported under another name from the file it comes from, never a same-named one", () => {
    expect(rowsOf("src/clubs.ts")).toEqual(["get /api/clubs", "get /api/clubs/${id}"]);
    expect((summary.apiCalls ?? []).some((c) => (c.target ?? "").startsWith("/api/decoy/api"))).toBe(false);
  });

  it("folds the slash a base-and-path joiner adds or leaves out, beside a same-named joiner elsewhere", () => {
    expect(rowsOf("src/fold.ts")).toEqual(["get /api/clubs", "get /api/clubs/1"]);
    expect(rowsOf("src/other-fold.ts")).toEqual(["get /decoy-base/clubs"]);
    expect(rowsOf("src/negated.ts")).toEqual(["get /api/players"]);
  });

  it("does not read a local bound to some other object's fetch member as the request function", () => {
    expect(rowsOf("src/cache.ts")).toEqual([]);
  });
});
