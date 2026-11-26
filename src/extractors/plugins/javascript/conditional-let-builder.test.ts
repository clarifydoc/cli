import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { resolveUrlBuilders } from "./url-builders.js";
import type { DataSourceInfo, FileAnalysis } from "../../../types/analysis.js";

/**
 * The conditional-`let` builder: `let url = origin + path;`, the query string added under a condition,
 * `return url`. The origin is a module constant read from the environment with an origin as its fallback,
 * so the helper hands the caller's path through unchanged.
 */
const GARAGE = `export const garageOrigin = import.meta.env.VITE_GARAGE_ORIGIN ?? "https://api.garage.example";
type Query = Record<string, string | number | boolean>;
export const garageUrl = (path: string, query?: Query) => {
    let url = garageOrigin + path;
    if (query) {
        const strings = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v.toString()]));
        url = \`\${url}?\${new URLSearchParams(strings).toString()}\`;
    }
    return url;
};
export function mechanicUrl(path: string, season?: string) {
    let url = garageOrigin + path;
    if (season) url += "?season=" + season;
    return url;
}
// the condition rewrites the path itself: no one template says what it builds
export const legacyUrl = (path: string, legacy: boolean) => {
    let url = garageOrigin + path;
    if (legacy) url = garageOrigin + "/legacy" + path;
    return url;
};
export const pathPrefixUrl = (path: string, legacy: boolean) => {
    let url = garageOrigin + path;
    if (legacy) url = "/legacy" + path;
    return url;
};
// a fallback that is a path prefix, not an origin: the prefix is part of the URL
const garagePrefix = process.env.GARAGE_PREFIX ?? "/api";
export const prefixedUrl = (path: string, query?: string) => {
    let url = garagePrefix + path;
    if (query) url = \`\${url}?\${query}\`;
    return url;
};
`;

const DECOY = `export const garageOrigin = import.meta.env.VITE_GARAGE_ORIGIN ?? "https://api.garage.example";
export const garageUrl = (path: string, query?: Record<string, string>) => {
    let url = garageOrigin + "/decoy-garage" + path;
    if (query) url = \`\${url}?\${new URLSearchParams(query).toString()}\`;
    return url;
};
`;

const CARS = `import { garageUrl } from "./garage";
export const listCars = async (make: string) => fetch(garageUrl("/api/cars", { make }));
export const serviceCar = async () => fetch(garageUrl("/api/cars/service"), { method: "POST" });
`;

async function functionsOf(src: string, file = "garage.ts") {
  const tree = await parseSource(src, "typescript" as any, file);
  return new JavaScriptExtractor().extractFunctions(tree, src);
}

async function apiCallsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "cars.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

function analysis(filePath: string, projectId: string, functions: FileAnalysis["functions"], imports: FileAnalysis["imports"] = []): FileAnalysis {
  return {
    filePath, language: "typescript", frameworks: [], projectId, imports, exports: [], functions, classes: [], routes: [],
    dataSources: [], dataMutations: [], subComponents: [], interactiveElements: [], events: [], screens: [],
  };
}

describe("a URL builder extended under a condition", () => {
  it("reads the path it is handed when the origin is an environment read with an origin fallback", async () => {
    const fns = await functionsOf(GARAGE);
    const tpl = (n: string) => fns.find((f) => f.name === n)?.urlTemplate;
    expect(tpl("garageUrl")).toBe("{path}");
    expect(tpl("mechanicUrl")).toBe("{path}");
    // the query string is not part of the template
    expect(fns.find((f) => f.name === "garageUrl")?.urlTemplateAlternatives).toBeUndefined();
  });

  it("states no template when a condition rewrites the path, or the fallback is a path prefix", async () => {
    const fns = await functionsOf(GARAGE);
    const tpl = (n: string) => fns.find((f) => f.name === n)?.urlTemplate;
    expect(tpl("legacyUrl")).toBeUndefined();
    expect(tpl("pathPrefixUrl")).toBeUndefined();
    expect(tpl("prefixedUrl")).toBeUndefined();
  });

  it("fills a call with its literal path, and takes the builder of the caller's own sub-project", async () => {
    const web = analysis("web/src/garage.ts", "web", await functionsOf(GARAGE));
    const admin = analysis("admin/src/garage.ts", "admin", await functionsOf(DECOY));
    const targetsFor = async (file: string, project: string) => {
      const calls = (await apiCallsOf(CARS)).map((c) => ({ ...c, filePath: file }));
      resolveUrlBuilders(calls, [web, admin, analysis(file, project, [])]);
      return calls.map((c) => c.target).sort();
    };
    expect(await targetsFor("web/src/cars.ts", "web")).toEqual(["/api/cars", "/api/cars/service"]);
    const adminTargets = (await targetsFor("admin/src/cars.ts", "admin")).join("\n");
    expect(adminTargets).toContain("/decoy-garage");
  });
});
