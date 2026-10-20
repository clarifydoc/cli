import { describe, it, expect } from "vitest";
import { filterKind, routeFilters, applyRouteMeta } from "./route-metadata.js";
import type { RouteInfo } from "../../types/analysis.js";

describe("route filters", () => {
  it("reads the kind off the name, in any framework's spelling", () => {
    const kinds = [
      "EnableRateLimiting(\"fixed\")", "throttle:60,1", "rateLimit({ windowMs: 60000 })", "Throttle({ default: { limit: 3 } })",
      "EnableCors(\"spa\")", "cors()", "ValidateAntiForgeryToken", "csurf()", "UsePipes(ValidationPipe)", "celebrate({ body })",
      "ResponseCache(Duration = 60)", "OutputCache", "Transactional", "LoggingInterceptor", "UseFilters(HttpExceptionFilter)",
      "requireAuth", "express.json()",
    ].map((t) => [t, filterKind(t)]);
    expect(Object.fromEntries(kinds)).toEqual({
      "EnableRateLimiting(\"fixed\")": "rate-limit", "throttle:60,1": "rate-limit", "rateLimit({ windowMs: 60000 })": "rate-limit",
      "Throttle({ default: { limit: 3 } })": "rate-limit", "EnableCors(\"spa\")": "cors", "cors()": "cors",
      ValidateAntiForgeryToken: "csrf", "csurf()": "csrf", "UsePipes(ValidationPipe)": "validation", "celebrate({ body })": "validation",
      "ResponseCache(Duration = 60)": "cache", OutputCache: "cache", Transactional: "transaction", LoggingInterceptor: "logging",
      "UseFilters(HttpExceptionFilter)": "error", requireAuth: null, "express.json()": null,
    });
  });

  it("marks a filter that switches its protection off, and where it was declared", () => {
    expect(routeFilters(["DisableRateLimiting", "SkipThrottle()", "IgnoreAntiforgeryToken"], true)).toEqual([
      { text: "DisableRateLimiting", kind: "rate-limit", inherited: true, enabled: false },
      { text: "SkipThrottle()", kind: "rate-limit", inherited: true, enabled: false },
      { text: "IgnoreAntiforgeryToken", kind: "csrf", inherited: true, enabled: false },
    ]);
    const route = { path: "/x", httpMethod: "POST", kind: "api", handler: null, calls: [], middleware: [], line: 1 } as RouteInfo;
    applyRouteMeta(route, { guards: [{ text: "auth:sanctum" }, { text: "throttle:6,1" }], inheritedFilters: ["cors()"] });
    expect(route.filters).toEqual([{ text: "cors()", kind: "cors", inherited: true }, { text: "throttle:6,1", kind: "rate-limit" }]);
  });
});
