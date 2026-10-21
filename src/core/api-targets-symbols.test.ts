import { describe, it, expect } from "vitest";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../parsers/parser-manager.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { resolveUrlBuilders } from "../extractors/plugins/javascript/url-builders.js";
import { extractImports } from "../extractors/imports-exports/index.js";
import { extractDataSources } from "../extractors/data-sources/index.js";
import { extractModuleValues } from "../extractors/plugins/javascript/module-values.js";
import { buildImportIndex } from "./import-index.js";
import { buildClassIndex } from "./class-index.js";
import { finalizeApiTargets, resolveSymbolicTargets } from "./api-targets.js";
import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";
import type { ProjectContext } from "../types/project.js";

async function project(files: Record<string, string>) {
  const analyses: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "typescript" as never, filePath);
    analyses.push({
      filePath,
      language: "typescript",
      projectId: "root",
      imports: extractImports(tree, src, "typescript" as never),
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, "typescript" as never),
      functions: extractFunctions(tree, src, "typescript" as never),
      dataSources: extractDataSources(tree, src, "typescript" as never),
      moduleValues: extractModuleValues(tree, src),
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(analyses);
  const ctx = { importIndex, classes: buildClassIndex(analyses, importIndex) } as ProjectContext;
  const calls = analyses.flatMap((a) =>
    a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath })),
  ) as Array<DataSourceInfo & { filePath: string }>;
  resolveUrlBuilders(calls, analyses, ctx);
  resolveSymbolicTargets(calls, analyses, ctx);
  finalizeApiTargets(calls);
  return calls.map((c) => (c.targetAlternatives ? [c.target, c.baseExpr ?? null, c.targetAlternatives] : [c.target, c.baseExpr ?? null]));
}

describe("resolveSymbolicTargets", () => {
  it("resolves a field set from an imported environment, and its loopback origin drops (Kavita)", async () => {
    const targets = await project({
      "src/environments/environment.ts": `const IP = 'localhost';\nexport const environment = { apiUrl: 'http://' + IP + ':5000/api/' };`,
      "src/app/series.service.ts": `
import { environment } from '../environments/environment';
export class SeriesService {
  baseUrl = environment.apiUrl;
  constructor(private httpClient: HttpClient) {}
  getSeries(seriesId: number) { return this.httpClient.get(this.baseUrl + 'series/' + seriesId); }
  getEmails() { return this.httpClient.get(\`\${this.baseUrl}email/all\`); }
}`,
    });
    expect(targets).toEqual([
      ["/api/series/${seriesId}", null],
      ["/api/email/all", null],
    ]);
  });

  it("reads a field from the class the call's class extends, set in its constructor", async () => {
    const targets = await project({
      "src/api.ts": `export const config = { PREFIX: "/api" };`,
      "src/base.ts": `
import { config } from './api';
export abstract class BaseService {
  protected root: string;
  constructor(protected http: HttpClient) { this.root = config.PREFIX + '/v2'; }
}`,
      "src/tags.service.ts": `
import { BaseService } from './base';
export class TagsService extends BaseService {
  list() { return this.http.get(\`\${this.root}/tags\`); }
}`,
    });
    expect(targets).toEqual([["/api/v2/tags", null]]);
  });

  it("falls back to the default of `a || b` when the project states only the default (chatwoot)", async () => {
    const targets = await project({
      "src/club.js": `
const DEFAULT_API_VERSION = 'v1';
class ClubAPI {
  constructor(options = {}) { this.url = \`/api/\${options.apiVersion || DEFAULT_API_VERSION}/clubs\`; }
  get(id) { return axios.get(\`\${this.url}/\${id}\`); }
}`,
    });
    expect(targets).toEqual([["/api/v1/clubs/${id}", null]]);
  });

  it("leaves a hole nothing explains to the base split", async () => {
    const targets = await project({
      "src/a.service.ts": `export class A { constructor(private http: HttpClient, private url: string) {} list() { return this.http.get(\`\${this.url}/items\`); } }`,
    });
    expect(targets).toEqual([["/items", "this.url"]]);
  });
});

describe("URL builders resolved where they are called", () => {
  async function linked(files: Record<string, string>) {
    const analyses: FileAnalysis[] = [];
    for (const [filePath, src] of Object.entries(files)) {
      const tree = await parseSource(src, "typescript" as never, filePath);
      analyses.push({
        filePath,
        language: "typescript",
        projectId: "root",
        imports: extractImports(tree, src, "typescript" as never),
        exports: [],
        entityRelations: [],
        classes: extractClasses(tree, src, "typescript" as never),
        functions: extractFunctions(tree, src, "typescript" as never),
        dataSources: extractDataSources(tree, src, "typescript" as never),
        moduleValues: extractModuleValues(tree, src),
      } as unknown as FileAnalysis);
    }
    const importIndex = buildImportIndex(analyses);
    const ctx = { importIndex, classes: buildClassIndex(analyses, importIndex) } as ProjectContext;
    const calls = analyses.flatMap((a) =>
      a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath })),
    ) as Array<DataSourceInfo & { filePath: string }>;
    resolveUrlBuilders(calls, analyses, ctx);
    resolveSymbolicTargets(calls, analyses, ctx);
    finalizeApiTargets(calls);
    return calls.map((c) => `${c.filePath.split("/").pop()}:${c.line} ${c.name} ${c.target}`);
  }

  const PAPERLESS = {
    "src/environments/environment.ts": `export const environment = { apiBaseUrl: 'http://localhost:8000/api/' };`,
    "src/app/services/abstract-paperless-service.ts": `
import { environment } from '../../environments/environment';
export abstract class AbstractPaperlessService<T> {
  protected baseUrl: string = environment.apiBaseUrl;
  constructor(protected http: HttpClient, protected resourceName: string) {}
  protected getResourceUrl(id: number = null, action: string = null): string {
    let url = \`\${this.baseUrl}\${this.resourceName}/\`;
    if (id !== null) url += \`\${id}/\`;
    if (action) url += \`\${action}/\`;
    return url;
  }
}`,
    "src/app/services/document.service.ts": `
import { AbstractPaperlessService } from './abstract-paperless-service';
export class DocumentService extends AbstractPaperlessService<Document> {
  constructor(http: HttpClient) { super(http, 'documents'); this.resourceName = 'documents'; }
  get(id: number) { return this.http.get(this.getResourceUrl(id)); }
  notes(id: number) { return this.http.get(this.getResourceUrl(id, 'notes')); }
  bulkEdit() { return this.http.post(this.getResourceUrl(null, 'bulk_edit'), {}); }
}`,
  };

  it("builds an inherited helper's URL from the CALLING subclass's fields, the variant its arguments pick (paperless)", async () => {
    expect(await linked(PAPERLESS)).toEqual([
      "document.service.ts:5 get /api/documents/{}/",
      "document.service.ts:6 get /api/documents/{}/notes/",
      "document.service.ts:7 post /api/documents/bulk_edit/",
    ]);
  });

  it("resolves a route table's arrow helper in its own file, over an imported prefix (mealie)", async () => {
    expect(
      await linked({
        "lib/api/config.ts": `const PREFIX = "/api";\nexport const config = { PREFIX };`,
        "lib/api/player/organizer-tags.ts": `
import { config } from '../config';
const prefix = config.PREFIX + "/organizers";
const routes = {
  tags: \`\${prefix}/tags\`,
  tagsSlug: (tag: string) => \`\${prefix}/tags/slug/\${tag}\`,
};
export class TagsAPI {
  constructor(private requests: ApiRequestInstance) {}
  bySlug(slug: string) { return this.requests.get(routes.tagsSlug(slug)); }
  all() { return this.requests.get(routes.tags); }
}`,
      }),
    ).toEqual(["organizer-tags.ts:10 get /api/organizers/tags/slug/{}", "organizer-tags.ts:11 get /api/organizers/tags"]);
  });

  it("does not let a variable argument stand for the segment that names the endpoint", async () => {
    // `/api/v1/{}` would join any `/api/v1/:id` route; the call stays unresolved.
    expect(
      await linked({
        "src/uri.ts": `export function apiUri(endpoint: string) { return '/api/v1/' + endpoint; }`,
        "src/a.service.ts": `import { apiUri } from './uri';\nexport function load(path) { return axios.get(apiUri(path)); }`,
      }),
    ).toEqual(["a.service.ts:2 get apiUri(path)"]);
  });
});

describe("resolveSymbolicTargets — a base client whose URL each subclass names through super()", () => {
  it("resolves `this.url` through the getter with its base put back, and `this.resource` from each subclass's super()", async () => {
    const rows = await project({
      "api/ApiClient.js": `class ApiClient {
  constructor(resource, options = {}) {
    this.apiVersion = \`/api/\${options.apiVersion || 'v1'}\`;
    this.options = options;
    this.resource = resource;
  }
  get url() { return \`\${this.baseUrl()}/\${this.resource}\`; }
  baseUrl() {
    let url = this.apiVersion;
    if (this.options.enterprise) url = \`/enterprise\${url}\`;
    if (this.options.clubScoped && this.clubIdFromRoute) url = \`\${url}/clubs/\${this.clubIdFromRoute}\`;
    return url;
  }
  get() { return axios.get(this.url); }
  show(id) { return axios.get(\`\${this.url}/\${id}\`); }
}
export default ApiClient;`,
      "api/contacts.js": `import ApiClient from './ApiClient';
class ContactAPI extends ApiClient {
  constructor() { super('contacts', { clubScoped: true }); }
  get(page) { return axios.get(this.url, { params: { page } }); }
}
export default new ContactAPI();`,
      "api/CacheEnabledApiClient.js": `import ApiClient from './ApiClient';
class CacheEnabledApiClient extends ApiClient {
  constructor(resource, options = {}) { super(resource, options); this.dataManager = null; }
}
export default CacheEnabledApiClient;`,
      "api/labels.js": `import CacheEnabledApiClient from './CacheEnabledApiClient';
class LabelsAPI extends CacheEnabledApiClient {
  constructor() { super('labels', { clubScoped: true }); }
}
export default new LabelsAPI();`,
    });
    const targets = rows.map((r) => r[0]).sort();
    // ApiClient.get is overridden by ContactAPI, so only LabelsAPI inherits it; show is inherited by both.
    // The getter's base comes back as `this.baseUrl()`, whose guarded reassignments are its variants.
    expect(targets).toEqual(["/api/v1/contacts", "/api/v1/contacts/${id}", "/api/v1/labels", "/api/v1/labels/${id}"]);
    const contacts = rows.find((r) => r[0] === "/api/v1/contacts")!;
    expect(contacts[2]).toEqual([
      "/enterprise/api/v1/contacts",
      "/api/v1/clubs/${this.clubIdFromRoute}/contacts",
      "/enterprise/api/v1/clubs/${this.clubIdFromRoute}/contacts",
    ]);
  });

  it("keeps one row per subclass when two request the same URL (paperless DocumentService, DocumentNotesService)", async () => {
    const targets = await project({
      "src/base.ts": `
export abstract class BaseCRUDAPI {
  public baseRoute: string;
  async createOne(payload: unknown) { return await this.requests.post(this.baseRoute, payload); }
}`,
      "src/documents.ts": `
import { BaseCRUDAPI } from "./base";
export class DocumentService extends BaseCRUDAPI { baseRoute = "/api/documents/"; }
export class DocumentNotesService extends BaseCRUDAPI { baseRoute = "/api/documents/"; }`,
    });
    expect(targets.map((t) => t[0])).toEqual(["/api/documents/", "/api/documents/"]);
  });

  it("fans a generic CRUD client's calls out to each subclass's route fields (mealie)", async () => {
    const targets = await project({
      "src/base/route.ts": `export function route(rest: string, params: Record<string, string> | null = null): string {
  const url = new URL(parts.prefix + rest, parts.host);
  return url.toString();
}`,
      "src/base/base-clients.ts": `
import { route } from "./route";
export abstract class BaseCRUDAPI {
  public baseRoute: string;
  itemRoute(itemId: string): string { return this.itemRouteFn(itemId); }
  async getAll(page = 1) { return await this.requests.get(route(this.baseRoute, { page })); }
  async createOne(payload: unknown) { return await this.requests.post(this.baseRoute, payload); }
  async deleteOne(itemId: string) { return await this.requests.delete(this.itemRoute(itemId)); }
  async duplicateOne(itemId: string) { return await this.requests.post(\`\${this.itemRoute(itemId)}/duplicate\`, {}); }
}`,
      "src/admin/admin-groups.ts": `
import { BaseCRUDAPI } from "../base/base-clients";
const prefix = "/api";
const routes = {
  adminGroups: \`\${prefix}/admin/groups\`,
  adminGroupsId: (id: string) => \`\${prefix}/admin/groups/\${id}\`,
};
export class AdminGroupsApi extends BaseCRUDAPI {
  baseRoute: string = routes.adminGroups;
  itemRoute = routes.adminGroupsId;
}`,
    });
    expect(targets.map((t) => t[0]).sort()).toEqual([
      "/api/admin/groups",
      "/api/admin/groups",
      "/api/admin/groups/{}",
      "/api/admin/groups/{}/duplicate",
    ]);
  });
});

