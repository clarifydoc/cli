import { describe, it, expect } from "vitest";
import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import { ROUTER_CALL, resolveRouterFunctions } from "./router-functions.js";

const route = (path: string, owner?: string): RouteInfo =>
  ({ path, httpMethod: "GET", kind: "api", handler: null, calls: [], middleware: [], line: 1, ...(owner ? { owner } : {}) }) as RouteInfo;
const file = (filePath: string, routes: RouteInfo[], facts: FileAnalysis["routeFacts"] = []): FileAnalysis =>
  ({ filePath, routes, routeFacts: facts, functions: [], classes: [], imports: [] }) as unknown as FileAnalysis;
const call = (callee: string, prefix: string) => ({ kind: ROUTER_CALL, line: 3, data: { callee, prefix, relative: false, guards: [] } });
const named = (callee: string, _c: FileAnalysis, keysNamed: (fn: string) => string[]) => keysNamed(callee)[0] ?? null;

describe("router functions: the owner marker lives only during the pass", () => {
  it("a package-keyed function (Go shape): served, uncalled and unreached rows lose it", () => {
    const pkg = (p: string) => p.slice(0, p.lastIndexOf("/"));
    const served = file("league/clubs.go", [route("/list", "fn:Register"), route("/idle", "fn:Idle")]);
    const main = file("league/main.go", [], [call("Register", "/clubs")]);
    resolveRouterFunctions([served, main], { unitOf: pkg, target: (c, _a, k) => k(c).find((x) => x.startsWith("league#")) ?? null });
    expect(served.routes.map((r) => r.path).sort()).toEqual(["/clubs/list", "/idle"]);
    expect(served.routes.some((r) => r.owner !== undefined)).toBe(false);
  });

  it("a file-keyed function (Express shape): app-only functions stay as written, owner gone", () => {
    const garage = file("garage.js", [route("/open/", "fn:mountOpen"), route("/cars", "fn:mountGarage")]);
    const app = file("app.js", [], [call("mountOpen", ""), call("mountGarage", "/away")]);
    resolveRouterFunctions([garage, app], { unitOf: (p) => p, target: named, skipPlain: true });
    expect(garage.routes.map((r) => r.path).sort()).toEqual(["/away/cars", "/open/"]);
    expect(garage.routes.some((r) => r.owner !== undefined)).toBe(false);
  });
});
