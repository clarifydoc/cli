import { describe, it, expect } from "vitest";
import { resolveUrlBuilders } from "./url-builders.js";
import type { DataSourceInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/**
 * Project-level resolution of URL-builder helper calls in api-call targets. The
 * helper definition (`requestUri`, `adminUri`) and its call sites live in
 * different files, so this pass joins the per-file `FunctionInfo.urlTemplate`
 * with the captured call-site target. one real repo's two SPAs funnel every axios call
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
  it("fills a destructured-object helper from the keys the call states", () => {
    const fixtureSearch = fn("fixtureSearchURL", "${host}/${leagueSlug}/fixtures?{}", []);
    const calls = [apiCall("fixtureSearchURL({ leagueSlug, page, host: '/api/v1/clubs' })"), apiCall("fixtureSearchURL({ leagueSlug, host: base.url })")];
    resolveUrlBuilders(calls, [analysis([fixtureSearch])]);
    expect(calls.map((c) => c.target)).toEqual(["/api/v1/clubs/${leagueSlug}/fixtures?{}", "${base.url}/${leagueSlug}/fixtures?{}"]);
  });

  it("substitutes literal args, dropping the env base and runtime refs to {}", () => {
    const calls = [apiCall("requestUri('teamtalk', 'v4')")];
    const n = resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(n).toBe(1);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/teamtalk");
  });

  it("applies a parameter default when the arg is omitted", () => {
    const calls = [apiCall("adminUri(`license/part`)")];
    resolveUrlBuilders(calls, [analysis([adminUri])]);
    expect(calls[0]!.target).toBe("/api/v1/license/part"); // version defaults to v1
  });

  it("reduces a concatenation arg to literals + {} wildcards", () => {
    // `requestUri('trainings/' + x.externalId, 'v2')` — the endpoint is built
    // by concatenation; the runtime part must become a {} so the path still
    // matches `/api/v{apiVersion}/institution/{id}/trainings/{externalId}`.
    const calls = [apiCall("requestUri('trainings/' + training.externalId, 'v2')", "put")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v2/institution/{}/trainings/{}");
  });

  it("keeps multiple literal segments around an interior runtime part", () => {
    const calls = [apiCall("requestUri('injurycodes/' + id + '/usage', 'v4')")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/injurycodes/{}/usage");
  });

  it("resolves a helper call embedded in a ${…} template, stripping the wrapper", () => {
    const calls = [apiCall("${requestUri('teamtalk', 'v4')}/${messageId}", "delete")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    expect(calls[0]!.target).toBe("/api/v4/institution/{}/teamtalk/${messageId}");
  });

  it("keeps a nested call inside a template arg intact (balanced parens)", () => {
    const calls = [apiCall("requestUri(`coaching/skill/${fagId}?${periodParams(period)}`, 'v1')")];
    resolveUrlBuilders(calls, [analysis([requestUri])]);
    // The endpoint (incl. its query string) is substituted whole; the inner
    // periodParams(...) call is left for the path normalizer to drop at `?`.
    expect(calls[0]!.target).toBe(
      "/api/v1/institution/{}/coaching/skill/${fagId}?${periodParams(period)}",
    );
  });

  it("leaves an unknown helper and a non-helper target untouched", () => {
    const calls = [apiCall("buildBall('x')"), apiCall("/api/v1/literal")];
    expect(resolveUrlBuilders(calls, [analysis([requestUri])])).toBe(0);
    expect(calls[0]!.target).toBe("buildBall('x')");
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
    const calls = [apiCall('configService.APIUrl("logout.json")', "post"), apiCall("this.config.APIUrl(`players/${id}.json`)")];
    expect(resolveUrlBuilders(calls, [configService])).toBe(2);
    expect(calls[0]!.target).toBe("/api/logout.json");
    expect(calls[1]!.target).toBe("/api/players/${id}.json");
    expect(calls[0]!.targetAlternatives).toBeUndefined();
  });

  it("fans a branching helper out into target + targetAlternatives, primary first", () => {
    const roleUri = fn("roleUri", "/api/staff/{sub}", [{ name: "sub", type: "string", defaultValue: null }]);
    roleUri.urlTemplateAlternatives = ["/api/{sub}"];
    const calls = [apiCall('configService.roleUri("referees.json")')];
    expect(resolveUrlBuilders(calls, [analysis([roleUri])])).toBe(1);
    expect(calls[0]!.target).toBe("/api/staff/referees.json");
    expect(calls[0]!.targetAlternatives).toEqual(["/api/referees.json"]);
  });

  it("leaves a call whose path argument is a bare variable unresolved", () => {
    // `APIUrl(url)` — nothing is known about the path; `/api/{}` would join
    // whatever `/api/:id` route exists. A version arg still takes its default.
    const calls = [apiCall("requestUri(url)"), apiCall("requestUri('x', version)")];
    expect(resolveUrlBuilders(calls, [analysis([requestUri])])).toBe(1);
    expect(calls[0]!.target).toBe("requestUri(url)");
    expect(calls[1]!.target).toBe("/api/v2/institution/{}/x");
  });

  it("fills a trailing parameter named for a record key with a wildcard", () => {
    const stream = fn("getMatchStreamUrl", "/matches/{id}/stream/{sessionId}", [
      { name: "id", type: "string", defaultValue: null },
      { name: "sessionId", type: "string", defaultValue: null },
    ]);
    const calls = [apiCall("getMatchStreamUrl(session.matchId, session.id)", "delete")];
    expect(resolveUrlBuilders(calls, [analysis([stream])])).toBe(1);
    expect(calls[0]!.target).toBe("/matches/{}/stream/{}");
  });

  it("is a no-op when the project defines no URL builders", () => {
    const calls = [apiCall("requestUri('x', 'v4')")];
    expect(resolveUrlBuilders(calls, [analysis([])])).toBe(0);
    expect(calls[0]!.target).toBe("requestUri('x', 'v4')");
  });
});
