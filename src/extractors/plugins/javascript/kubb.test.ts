import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractKubbConfigs, resolveKubbClientCalls } from "./kubb.js";
import { createEmptyAnalysis, type FileAnalysis, type GeneratedClientConfig, type ImportInfo, type RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

async function configsOf(src: string, path = "web/kubb.config.ts"): Promise<GeneratedClientConfig[]> {
  return extractKubbConfigs(await parseSource(src, "typescript" as any, path), src, path);
}

describe("Kubb config", () => {
  it("reads the spec and each per-operation output, relative to the config and its root", async () => {
    expect(await configsOf(`import { defineConfig } from '@kubb/core'
export default defineConfig({
  root: '.',
  input: { path: './api.json' },
  output: { path: './src/api', clean: true, extension: { '.ts': '' } },
  plugins: [
    pluginOas(),
    pluginTs({ output: { path: 'models' } }),
    pluginClient({ output: { path: 'clients' } }),
    pluginZod({ output: { path: 'zod' } }),
  ],
})`)).toEqual([{ generator: "kubb", spec: "web/api.json", root: "web/src/api", outputs: [{ dir: "web/src/api/clients", kind: "client" }], line: 2 }]);
  });

  it("takes each plugin's default directory, and every config of an array", async () => {
    const cfgs = await configsOf(`export default defineConfig([
  { input: { path: 'specs/league.yaml' }, output: { path: 'gen' }, plugins: [pluginClient(), pluginVueQuery({})] },
  { root: 'cup', input: { path: 'cup.json' }, output: { path: 'out' }, plugins: [pluginTs()] },
  { input: { path: 'https://example.com/spec.json' }, output: { path: 'remote' }, plugins: [pluginClient()] },
])`, "kubb.config.ts");
    expect(cfgs.map((c) => [c.spec, c.root, c.outputs.map((o) => `${o.kind} ${o.dir}`)])).toEqual([
      ["specs/league.yaml", "gen", ["client gen/clients", "hook gen/hooks"]],
    ]);
  });

  it("reads only a kubb config file", async () => {
    expect(await configsOf("export default defineConfig({ input: { path: 'a.json' }, output: { path: 'b' }, plugins: [pluginClient()] })", "web/vite.config.ts")).toEqual([]);
  });
});

const route = (httpMethod: string, path: string, handler: string): RouteInfo =>
  ({ path, httpMethod, kind: "api", handler, calls: [], middleware: [], line: 1 });

const imp = (source: string, specifiers: string[], extra: Partial<ImportInfo> = {}): ImportInfo =>
  ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1, ...extra });

function fileCalling(path: string, imports: ImportInfo[], callNames: string[], declared: string[] = []): FileAnalysis {
  return {
    ...createEmptyAnalysis(path, "typescript"),
    imports,
    functions: [
      { name: "run", params: [], returnType: null, isAsync: true, isExported: true, decorators: [], line: 1, endLine: 99,
        calls: callNames.map((name, i) => ({ name, kind: "internal" as const, target: null, line: 10 + i })) },
      ...declared.map((name) => ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], line: 100, endLine: 101, calls: [] })),
    ],
  };
}

describe("Kubb client calls", () => {
  const config: FileAnalysis = {
    ...createEmptyAnalysis("web/kubb.config.ts", "typescript"),
    generatedClients: [{ generator: "kubb", spec: "web/api.json", root: "web/src/api", outputs: [
      { dir: "web/src/api/clients", kind: "client" }, { dir: "web/src/api/hooks", kind: "hook" },
    ], line: 1 }],
  };
  const spec: FileAnalysis = {
    ...createEmptyAnalysis("web/api.json", "openapi" as any),
    routes: [
      route("GET", "/league/clubs/{id}", "getClub"),
      route("GET", "/league/archive/clubs/{id}", "getClub_1"),
      route("DELETE", "/league/clubs/{id}", "deleteClub"),
      route("POST", "/league/transfers", "create-transfer"),
    ],
  };
  const run = (files: FileAnalysis[], onDisk: string[] = []) => {
    const byPath = new Map([config, spec, ...files].map((a) => [a.filePath, a]));
    const ctx = { fileOf: (p: string) => byPath.get(p), resolveModule: (_f: string, s: string) => (onDisk.includes(s) ? s : null) } as unknown as ProjectContext;
    const calls: ProjectApiCall[] = [];
    resolveKubbClientCalls(calls, [config, spec, ...files], ctx);
    return calls.map((c) => `${c.filePath}:${c.line} ${c.name} ${c.target} ${c.endpoint}`);
  };

  it("a call of a per-operation module requests that operation, aliased or not", () => {
    expect(run([fileCalling("web/src/store/clubs.ts", [
      imp("web/src/api/clients/getClub", ["getClub"]),
      imp("web/src/api/clients/deleteClub", ["removeClub", "deleteClub"]),
      imp("web/src/api/clients/getClub1", ["getClub1"]),
      imp("web/src/api/clients/createTransfer.ts", ["createTransfer"]),
    ], ["getClub", "removeClub", "getClub1", "createTransfer", "other"])])).toEqual([
      "web/src/store/clubs.ts:10 get /league/clubs/{id} getClub",
      "web/src/store/clubs.ts:11 delete /league/clubs/{id} deleteClub",
      "web/src/store/clubs.ts:12 get /league/archive/clubs/{id} getClub_1",
      "web/src/store/clubs.ts:13 post /league/transfers create-transfer",
    ]);
  });

  it("a per-operation module answers only for its own operation", () => {
    expect(run([fileCalling("web/src/a.ts", [imp("web/src/api/clients/getClub", ["getGetClubUrl", "deleteClub"])], ["getGetClubUrl", "deleteClub"])])).toEqual([]);
  });

  it("a barrel, a relative path, a namespace and a generated hook name their operations", () => {
    expect(run([
      fileCalling("web/src/views/Club.vue", [imp("../api/clients", ["getClub"]), imp("../api", ["useGetClub"])], ["getClub", "useGetClub"]),
      fileCalling("web/src/b.ts", [imp("web/src/api/clients", ["api"], { isNamespace: true })], ["api.deleteClub", "api.nope"]),
    ])).toEqual([
      "web/src/views/Club.vue:10 get /league/clubs/{id} getClub",
      "web/src/views/Club.vue:11 get /league/clubs/{id} getClub",
      "web/src/b.ts:10 delete /league/clubs/{id} deleteClub",
    ]);
  });

  it("adds nothing when the generated module is on disk, or a local function shadows the name", () => {
    expect(run([
      fileCalling("web/src/a.ts", [imp("web/src/api/clients/getClub", ["getClub"])], ["getClub"]),
      fileCalling("web/src/b.ts", [imp("web/src/api/clients/deleteClub", ["deleteClub"])], ["deleteClub"], ["deleteClub"]),
      fileCalling("web/src/c.ts", [imp("web/src/api/models/Club", ["Club"])], ["Club"]),
    ], ["web/src/api/clients/getClub"])).toEqual([]);
  });
});
