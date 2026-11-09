import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A client class building a sibling endpoint by editing its own base:
 * `${this.url.replace(this.resource, '')}callbacks/kit`, where `url` is a getter
 * (`${this.baseUrl()}/${this.resource}`) and `resource` is what the subclass hands
 * `super('clubs', …)`. The edit is evaluated over the getter's template, so the call
 * requests `/api/v1/accounts/{}/callbacks/kit` (real-repo FP: the request had lost its base).
 */
describe("a getter URL edited by .replace, end to end", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-url-edits-"));
    const web = join(dir, "web", "src", "api");
    const server = join(dir, "server");
    await mkdir(web, { recursive: true });
    await mkdir(server, { recursive: true });
    await writeFile(join(dir, "web", "package.json"), JSON.stringify({ name: "league-web", dependencies: { axios: "1.6.0" } }));
    await writeFile(join(web, "ApiClient.js"), [
      "class ApiClient {",
      "  constructor(resource, options = {}) {",
      "    this.apiVersion = `/api/${options.apiVersion || 'v1'}`;",
      "    this.options = options;",
      "    this.resource = resource;",
      "  }",
      "  get url() {",
      "    return `${this.baseUrl()}/${this.resource}`;",
      "  }",
      "  get accountIdFromRoute() {",
      "    return window.location.pathname.split('/')[3];",
      "  }",
      "  baseUrl() {",
      "    let url = this.apiVersion;",
      "    if (this.options.accountScoped && this.accountIdFromRoute) {",
      "      url = `${url}/accounts/${this.accountIdFromRoute}`;",
      "    }",
      "    return url;",
      "  }",
      "}",
      "export default ApiClient;",
    ].join("\n"));
    await writeFile(join(web, "clubs.js"), [
      "import ApiClient from './ApiClient';",
      "class ClubsAPI extends ApiClient {",
      "  constructor() {",
      "    super('clubs', { accountScoped: true });",
      "  }",
      "  registerKit(params) {",
      "    return axios.post(`${this.url.replace(this.resource, '')}callbacks/kit`, params);",
      "  }",
      "  renewKit(params) {",
      "    return axios.post(`${this.url.replaceAll(this.resource, 'kits')}/renew`, params);",
      "  }",
      "  notifyBoard(params) {",
      "    return axios.post(`${this.url.replace(/clubs/, 'sponsors').replace('sponsors', 'boards')}/notify`, params);",
      "  }",
      "  kits() {",
      "    return axios.get(this.url.replace(this.resource, 'kits'));",
      "  }",
      "  // The search value is set at run time: nothing to evaluate.",
      "  dropBoots(kind) {",
      "    this.kind = kind;",
      "    return axios.post(`${this.url.replace(this.kind, '')}callbacks/boots`);",
      "  }",
      "  // Text the template does not show, with a hole that may hold it: nothing claimed.",
      "  dropTeams() {",
      "    return axios.post(`${this.url.replace('teams', '')}callbacks/teams`);",
      "  }",
      "}",
      "export default new ClubsAPI();",
    ].join("\n"));
    await writeFile(join(server, "package.json"), JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0" } }));
    await writeFile(join(server, "app.js"), [
      "const express = require('express');",
      "const router = express.Router();",
      "router.post('/api/v1/accounts/:account_id/callbacks/kit', (req, res) => res.json({}));",
      "router.post('/api/v1/accounts/:account_id/kits/renew', (req, res) => res.json({}));",
      "router.post('/api/v1/accounts/:account_id/boards/notify', (req, res) => res.json({}));",
      "router.get('/api/v1/accounts/:account_id/kits', (req, res) => res.json([]));",
      "router.post('/api/v1/accounts/:account_id/callbacks/boots', (req, res) => res.json({}));",
      "router.post('/api/v1/accounts/:account_id/callbacks/teams', (req, res) => res.json({}));",
      "const app = express();",
      "app.use(router);",
      "app.listen(3000);",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const routeOf = (line: number): string | undefined =>
    summary.apiRouteLinks?.find((l) => l.source === "web/src/api/clubs.js" && l.sourceLine === line)?.routePath;
  const callAt = (line: number) => summary.apiCalls?.find((c) => c.filePath === "web/src/api/clubs.js" && c.line === line);

  it("takes the resource out of the base and links the sibling endpoint", () => {
    expect(callAt(7)?.targetAlternatives).toContain("/api/v1/accounts/${this.accountIdFromRoute}/callbacks/kit");
    expect(routeOf(7)).toBe("/api/v1/accounts/:account_id/callbacks/kit");
  });

  it("evaluates replaceAll, a plain regex, a chain and a bare edited read", () => {
    expect(routeOf(10)).toBe("/api/v1/accounts/:account_id/kits/renew");
    expect(routeOf(13)).toBe("/api/v1/accounts/:account_id/boards/notify");
    expect(routeOf(16)).toBe("/api/v1/accounts/:account_id/kits");
  });

  it("leaves the base unresolved when the search value is not known", () => {
    expect(callAt(21)?.target).toBe("/callbacks/boots");
    expect(callAt(21)?.baseExpr).toBe("this.url.replace(this.kind, '')");
    expect(callAt(25)?.target).toBe("/callbacks/teams");
    expect(callAt(25)?.baseExpr).toBe("this.url.replace('teams', '')");
  });
});
