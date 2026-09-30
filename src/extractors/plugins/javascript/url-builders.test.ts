import { describe, it, expect } from "vitest";
import { resolveUrlBuilders } from "./url-builders.js";
import type { DataSourceInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/**
 * Project-level resolution of URL-builder helper calls in api-call targets. The
 * helper definition (`requestUri`, `adminUri`) and its call sites live in
 * different files, so this pass joins the per-file `FunctionInfo.urlTemplate`
 * with the captured call-site target. tessa's two SPAs funnel every axios call
 * through such a helper, so without this the screen→API join was dead (0 links).
 */

function fn(name: string, urlTemplate: string, params: FunctionInfo["params"]): FunctionInfo {
  return {
    name,
    params,
    returnType: "string",
    isAsync: false,
    isExported: true,
    decorators: [],
    calls: [],
    line: 1,
    endLine: 3,
    urlTemplate,
  };
}

function analysis(functions: FunctionInfo[]): FileAnalysis {
  return {
    filePath: "utils/uriUtils.ts",
    language: "typescript",
    frameworks: [],
    projectId: "root",
    imports: [],
    exports: [],
    functions,
    classes: [],
    routes: [],
    dataSources: [],
    dataMutations: [],
    subComponents: [],
    interactiveElements: [],
    events: [],
    screens: [],
  };
}

function apiCall(target: string, name = "get"): DataSourceInfo & { filePath: string } {
  return { kind: "api-call", name, target, calls: [], line: 1, filePath: "svc.ts" };
}

const requestUri = fn("requestUri", "/api/{version}/institution/{}/{endpoint}", [
  { name: "endpoint", type: "string", defaultValue: null },
  { name: "version", type: "string", defaultValue: "'v2'" },
]);
const adminUri = fn("adminUri", "/api/{version}/{aSubPath}", [
  { name: "aSubPath", type: "string", defaultValue: null },
  { name: "version", type: "string", defaultValue: "'v1'" },
]);

describe("resolveUrlBuilders", () => {
  it("substitutes literal args, dropping the env base and runtime refs to {}", () => {
    const calls = [apiCall("requestUri('vikarbesked', 'v4')")];
    const n = resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(n).toBe(1);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/vikarbesked");
  });

  it("applies a parameter default when the arg is omitted", () => {
    const calls = [apiCall("adminUri(`license/product`)")];
    resolveUrlBuilders(calls, [analysis([adminUri])]);
    expect(calls[0]!.target).toBe("/api/v1/license/product"); // version defaults to v1
  });

  it("reduces a concatenation arg to literals + {} wildcards", () => {
    // `requestUri('aktiviteter/' + x.externalId, 'v2')` — the endpoint is built
    // by concatenation; the runtime part must become a {} so the path still
    // matches `/api/v{apiVersion}/institution/{id}/aktiviteter/{externalId}`.
    const calls = [apiCall("requestUri('aktiviteter/' + aktivitet.externalId, 'v2')", "put")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v2/institution/{}/aktiviteter/{}");
  });

  it("keeps multiple literal segments around an interior runtime part", () => {
    const calls = [apiCall("requestUri('fravaerkoder/' + id + '/usage', 'v4')")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/fravaerkoder/{}/usage");
  });

  it("resolves a helper call embedded in a ${…} template, stripping the wrapper", () => {
    const calls = [apiCall("${requestUri('vikarbesked', 'v4')}/${beskedId}", "delete")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/vikarbesked/${beskedId}");
  });

  it("keeps a nested call inside a template arg intact (balanced parens)", () => {
    const calls = [apiCall("requestUri(`undervisning/fag/${fagId}?${periodParams(period)}`, 'v1')")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    // The endpoint (incl. its query string) is substituted whole; the inner
    // periodParams(...) call is left for the path normalizer to drop at `?`.
    expect(calls[0]!.target).toBe(
      "/api/v1/institution/{}/undervisning/fag/${fagId}?${periodParams(period)}",
    );
  });

  it("leaves an unknown helper and a non-helper target untouched", () => {
    const calls = [apiCall("buildSomething('x')"), apiCall("/api/v1/literal")];
    expect(resolveUrlBuilders(calls, [analysis([requestUri])])).toBe(0);
    expect(calls[0]!.target).toBe("buildSomething('x')");
    expect(calls[1]!.target).toBe("/api/v1/literal");
  });

  it("drops a name whose template diverges across files (ambiguous → unresolved)", () => {
    const other = fn("requestUri", "/other/{endpoint}", [
      { name: "endpoint", type: "string", defaultValue: null },
    ]);
    const calls = [apiCall("requestUri('x', 'v4')")];
    const n = resolveUrlBuilders(calls, [analysis([requestUri]), analysis([other])]);
    expect(n).toBe(0);
    expect(calls[0]!.target).toBe("requestUri('x', 'v4')");
  });

  it("indexes class methods and consumes the receiver of a `service.method(...)` call", () => {
    // `configService.APIUrl("logout.json")` — the helper is a method on a
    // service singleton; the receiver only says where it lives.
    const configService = analysis([]);
    configService.classes = [
      {
        name: "ConfigService",
        extends: null,
        implements: [],
        decorators: [],
        properties: [],
        isExported: false,
        line: 1,
        endLine: 9,
        methods: [fn("APIUrl", "/api/{aSubPath}", [{ name: "aSubPath", type: "string", defaultValue: null }])],
      },
    ];
    const calls = [apiCall('configService.APIUrl("logout.json")', "post"), apiCall("this.config.APIUrl(`users/${id}.json`)")];
    expect(resolveUrlBuilders(calls, [configService])).toBe(2);
    expect(calls[0]!.target).toBe("/api/logout.json");
    expect(calls[1]!.target).toBe("/api/users/${id}.json");
    expect(calls[0]!.targetAlternatives).toBeUndefined();
  });

  it("fans a branching helper out into target + targetAlternatives, primary first", () => {
    const roleUri = fn("roleUri", "/api/personale/{sub}", [{ name: "sub", type: "string", defaultValue: null }]);
    roleUri.urlTemplateAlternatives = ["/api/{sub}"];
    const calls = [apiCall('configService.roleUri("employees.json")')];
    expect(resolveUrlBuilders(calls, [analysis([roleUri])])).toBe(1);
    expect(calls[0]!.target).toBe("/api/personale/employees.json");
    expect(calls[0]!.targetAlternatives).toEqual(["/api/employees.json"]);
  });

  it("leaves a call whose path argument is a bare variable unresolved", () => {
    // `APIUrl(url)` — nothing is known about the path; `/api/{}` would join
    // whatever `/api/:id` route exists. A version arg still takes its default.
    const calls = [apiCall("requestUri(url)"), apiCall("requestUri('x', version)")];
    expect(resolveUrlBuilders(calls, [analysis([requestUri])])).toBe(1);
    expect(calls[0]!.target).toBe("requestUri(url)");
    expect(calls[1]!.target).toBe("/api/v2/institution/{}/x");
  });

  it("is a no-op when the project defines no URL builders", () => {
    const calls = [apiCall("requestUri('x', 'v4')")];
    expect(resolveUrlBuilders(calls, [analysis([])])).toBe(0);
    expect(calls[0]!.target).toBe("requestUri('x', 'v4')");
  });
});
