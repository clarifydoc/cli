import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { resolveUrlBuilders } from "./url-builders.js";
import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";

/**
 * What a call hands a URL builder: a local holding a template, a sync helper over a named base,
 * and a builder name two sub-projects both declare.
 */
const GARAGE = `declare function readBase(): Promise<string>;
const API_BASE = "https://api.example";
export const garageUrl = async (path: string) => \`\${await readBase()}/garage\${path}\`;
export const apiPath = (path: string) => \`\${API_BASE}\${path}\`;
`;

// Same names, another base: the decoy of a sub-project the caller below does not belong to.
const DECOY = `declare function readBase(): Promise<string>;
const API_BASE = "https://api.example";
export const garageUrl = async (path: string) => \`\${await readBase()}/decoy-garage\${path}\`;
export const apiPath = (path: string) => \`\${API_BASE}/v9\${path}\`;
`;

const CARS = `import { garageUrl, apiPath } from "@lib/garage";
declare function slot(kind: string): string;
export async function loadSlot(id: number, kind: string) {
  const path = \`/cars/\${slot(kind)}/\${id}\`;
  return fetch(await garageUrl(path));
}
export async function loadSync(id: number) {
  return fetch(apiPath(\`/cars/sync/\${id}\`));
}
export async function loadChanging(id: number) {
  let changing = \`/cars/a/\${id}\`;
  changing = \`/cars/b/\${id}\`;
  return fetch(await garageUrl(changing));
}
const shared = \`/cars/shared/\${1}\`;
export async function loadShared() {
  return fetch(await garageUrl(shared));
}
`;

async function functionsOf(src: string, file: string) {
  const tree = await parseSource(src, "typescript" as any, file);
  return new JavaScriptExtractor().extractFunctions(tree, src);
}

async function apiCallsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "cars.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

function analysis(filePath: string, projectId: string, functions: FileAnalysis["functions"]): FileAnalysis {
  return {
    filePath, language: "typescript", frameworks: [], projectId, imports: [], exports: [], functions, classes: [], routes: [],
    dataSources: [], dataMutations: [], subComponents: [], interactiveElements: [], events: [], screens: [],
  };
}

describe("arguments a URL builder is handed", () => {
  it("reads a sync helper over a named base as the path it is handed", async () => {
    const fns = await functionsOf(GARAGE, "garage.ts");
    expect(fns.find((f) => f.name === "apiPath")?.urlTemplate).toBe("${API_BASE}{path}");
    expect(fns.find((f) => f.name === "garageUrl")?.urlTemplate).toBe("/garage{path}");
  });

  it("writes a local holding a template in the call that is handed it", async () => {
    const calls = await apiCallsOf(CARS);
    expect(calls.map((c) => c.target).sort()).toEqual([
      "apiPath(`/cars/sync/${id}`)",
      "garageUrl(`/cars/${slot(kind)}/${id}`)",
      // a local set twice is no one template
      "garageUrl(changing)",
      // a template of another scope is the module-value pass's
      "garageUrl(shared)",
    ]);
  });

  it("takes the builder the caller's own sub-project declares when two sub-projects share its name", async () => {
    const web = analysis("web/src/garage.ts", "web", await functionsOf(GARAGE, "garage.ts"));
    const admin = analysis("admin/src/garage.ts", "admin", await functionsOf(DECOY, "garage.ts"));
    const calls = (await apiCallsOf(CARS)).map((c) => ({ ...c, filePath: "web/src/cars.ts" }));
    resolveUrlBuilders(calls, [web, admin, analysis("web/src/cars.ts", "web", []), analysis("admin/src/cars.ts", "admin", [])]);
    const targets = calls.map((c) => c.target).sort();
    expect(targets).toContain("${API_BASE}/cars/sync/${id}");
    expect(targets.some((t) => (t ?? "").includes("/cars/${slot(kind)}/${id}") && !(t ?? "").includes("decoy"))).toBe(true);
    expect(targets.join("\n")).not.toMatch(/decoy|\/v9/);
  });

  it("gives the other sub-project its own builder for the same call", async () => {
    const web = analysis("web/src/garage.ts", "web", await functionsOf(GARAGE, "garage.ts"));
    const admin = analysis("admin/src/garage.ts", "admin", await functionsOf(DECOY, "garage.ts"));
    const calls = (await apiCallsOf(CARS)).map((c) => ({ ...c, filePath: "admin/src/cars.ts" }));
    resolveUrlBuilders(calls, [web, admin, analysis("web/src/cars.ts", "web", []), analysis("admin/src/cars.ts", "admin", [])]);
    expect(calls.map((c) => c.target).sort()).toContain("${API_BASE}/v9/cars/sync/${id}");
    expect(calls.map((c) => c.target).join("\n")).toContain("/decoy-garage/cars/");
  });

  it("writes a local template with a multi-line hole or an escaped character in the call", async () => {
    const calls = await apiCallsOf(`import { apiPath } from "@lib/garage";
export async function loadMulti(id: number) {
  const path = \`/cars/\${
    id
  }/seats\`;
  return fetch(apiPath(path));
}
export async function loadEscaped(id: number) {
  const path = \`/cars/\\u0041/\${id}\`;
  return fetch(apiPath(path));
}
export async function loadLiteralBrace(id: number) {
  const path = \`/cars/\\\${id}\`;
  return fetch(apiPath(path));
}
export async function loadBroken(id: number) {
  const path = \`/cars/line
break/\${id}\`;
  return fetch(apiPath(path));
}
`);
    const targets = calls.map((c) => c.target).sort();
    expect(targets).toContain("apiPath(`/cars/${id}/seats`)");
    expect(targets).toContain("apiPath(`/cars/A/${id}`)");
    expect(targets.filter((t) => t === "apiPath(path)")).toHaveLength(2);
    // an escaped `$` beside `{id}` is text, never a hole
    expect(targets).not.toContain("apiPath(`/cars/${id}`)");
    expect(targets).toHaveLength(4);
  });

  it("keeps a lowercase module constant as the base of a path-handing helper", async () => {
    const fns = await functionsOf(`const apiBase = "/api";
export const carPath = (path: string) => \`\${apiBase}\${path}\`;
export function carPathMut(path: string) {
  let base = "/api";
  return \`\${base}\${path}\`;
}
const stadiumOrigin = process.env.STADIUM_ORIGIN ?? "/api";
export const envPath = (path: string) => \`\${stadiumOrigin}\${path}\`;
export const carPathParam =(base: string, path: string) => \`\${base}\${path}\`;
`, "garage.ts");
    expect(fns.find((f) => f.name === "carPath")?.urlTemplate).toBe("${apiBase}{path}");
    // a local folds to its own value, never a `${base}` hole
    expect(fns.find((f) => f.name === "carPathMut")?.urlTemplate).toBe("/api{path}");
    expect(fns.find((f) => f.name === "carPathParam")?.urlTemplate).toBeUndefined();
    // a base read from the environment is a runtime value, not one every namesake helper shares
    expect(fns.find((f) => f.name === "envPath")?.urlTemplate).toBeUndefined();
  });
});
