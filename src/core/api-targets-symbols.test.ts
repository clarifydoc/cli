import { describe, it, expect } from "vitest";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../parsers/parser-manager.js";
import { extractClasses } from "../extractors/functions-classes/index.js";
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
      dataSources: extractDataSources(tree, src, "typescript" as never),
      moduleValues: extractModuleValues(tree, src),
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(analyses);
  const ctx = { importIndex, classes: buildClassIndex(analyses, importIndex) } as ProjectContext;
  const calls = analyses.flatMap((a) =>
    a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath })),
  ) as Array<DataSourceInfo & { filePath: string }>;
  resolveSymbolicTargets(calls, analyses, ctx);
  finalizeApiTargets(calls);
  return calls.map((c) => [c.target, c.baseExpr ?? null]);
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
      "src/account.js": `
const DEFAULT_API_VERSION = 'v1';
class AccountAPI {
  constructor(options = {}) { this.url = \`/api/\${options.apiVersion || DEFAULT_API_VERSION}/accounts\`; }
  get(id) { return axios.get(\`\${this.url}/\${id}\`); }
}`,
    });
    expect(targets).toEqual([["/api/v1/accounts/${id}", null]]);
  });

  it("leaves a hole nothing explains to the base split", async () => {
    const targets = await project({
      "src/a.service.ts": `export class A { constructor(private http: HttpClient, private url: string) {} list() { return this.http.get(\`\${this.url}/items\`); } }`,
    });
    expect(targets).toEqual([["/items", "this.url"]]);
  });
});
