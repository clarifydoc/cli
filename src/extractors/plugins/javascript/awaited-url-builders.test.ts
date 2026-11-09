import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { resolveUrlBuilders } from "./url-builders.js";
import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";

/**
 * An async URL builder: the origin is read from storage (`await garageOrigin()`), so the
 * helper is awaited where a request is made — `fetch(await garageUrl("/cars/service"))`,
 * or `const url = await garageUrl("/cars")` interpolated into the request.
 */
const ORIGINS = `import { readSetting } from "./settings";
export const garageOrigin = async () => (await readSetting("garageOrigin")) ?? "https://api.garage.example";
export const garageUrl = async (path: string, queryParams?: Record<string, string>) => {
    let url = (await garageOrigin()) + path;
    if (queryParams) {
        const params = new URLSearchParams(queryParams);
        url = \`\${url}?\${params.toString()}\`;
    }
    return url;
};
export const pitUrl = async (path: string) => \`\${await garageOrigin()}\${path}\`;
export const garageAuthHeaders = async () => ({ "X-Auth-Token": await readSetting("token") });
export const badgeLabel = async (name: string) => (await readSetting("prefix")) + name;
`;

const CARS = `import { garageUrl, pitUrl, garageAuthHeaders } from "./origins";
const expectOk = (res: Response) => { if (!res.ok) throw new Error("failed"); };
export const serviceCar = async (carId: number) => {
    const res = await fetch(await garageUrl("/cars/service"), {
        method: "POST",
        headers: await garageAuthHeaders(),
        body: JSON.stringify({ carId }),
    });
    expectOk(res);
};
export const listCars = async () => {
    const url = await garageUrl("/cars");
    const res = await fetch(\`\${url}?make=volvo\`, { headers: await garageAuthHeaders() });
    return res.json();
};
export const listMechanics = async () => {
    expectOk(await fetch(await garageUrl("/mechanics", { active: "true" }), { headers: await garageAuthHeaders() }));
};
export const carTyres = async (carId: string) => {
    const url = await garageUrl(\`/cars/\${carId}/tyres\`);
    return fetch(\`\${url}?season=winter\`);
};
export const postToGarage = async (path: string, body: unknown) => {
    const res = await fetch(await garageUrl(path), { method: "POST", body: JSON.stringify(body) });
    expectOk(res);
};
export const reportLap = async (raw: string) => {
    const lapId = parseInt(raw);
    return fetch(\`/laps/\${lapId}/report\`, { method: "POST" });
};
export const pitStop = async () => {
    const res = await fetch(await pitUrl("/pit/stop"), { method: "PUT" });
    expectOk(res);
};
`;

async function functionsOf(src: string) {
  const tree = await parseSource(src, "typescript" as any, "origins.ts");
  return new JavaScriptExtractor().extractFunctions(tree, src);
}

async function apiCallsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "cars.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

function analysis(filePath: string, functions: FileAnalysis["functions"]): FileAnalysis {
  return {
    filePath, language: "typescript", frameworks: [], projectId: "root", imports: [], exports: [], functions, classes: [], routes: [],
    dataSources: [], dataMutations: [], subComponents: [], interactiveElements: [], events: [], screens: [],
  };
}

describe("an awaited URL builder", () => {
  it("reads an async builder on an awaited origin as the path it is handed", async () => {
    const fns = await functionsOf(ORIGINS);
    const tpl = (n: string) => fns.find((f) => f.name === n)?.urlTemplate;
    expect(tpl("garageUrl")).toBe("{path}");
    // The origin it is built on stays named.
    expect(fns.find((f) => f.name === "garageUrl")?.urlTemplateBase).toBe("garageOrigin()");
    expect(tpl("pitUrl")).toBe("{path}");
    // A header builder and a label built on a stored prefix are no URLs.
    expect(tpl("garageAuthHeaders")).toBeUndefined();
    expect(tpl("badgeLabel")).toBeUndefined();
    expect(tpl("garageOrigin")).toBeUndefined();
  });

  it("takes an awaited builder call as the URL argument and as a local's initializer", async () => {
    const calls = await apiCallsOf(CARS);
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      'get ${garageUrl("/cars")}?make=volvo',
      "get ${garageUrl(`/cars/${carId}/tyres`)}?season=winter",
      'get garageUrl("/mechanics", { active: "true" })',
      "post /laps/${lapId}/report",
      'post garageUrl("/cars/service")',
      "post garageUrl(path)",
      'put pitUrl("/pit/stop")',
    ]);
  });

  // A request wrapper handing its own parameter to the builder becomes a `${path}` hole the
  // request-factory pass fills from the wrapper's callers; a local mid-URL holding some other call stays a hole.
  it("resolves the awaited calls through the builder's template", async () => {
    const fns = await functionsOf(ORIGINS);
    const calls = (await apiCallsOf(CARS)).map((c) => ({ ...c, filePath: "cars.ts" }));
    resolveUrlBuilders(calls, [analysis("origins.ts", fns)]);
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      "get /cars/${carId}/tyres?season=winter",
      "get /cars?make=volvo",
      "get /mechanics",
      "post ${path}",
      "post /cars/service",
      "post /laps/${lapId}/report",
      "put /pit/stop",
    ]);
  });
});
