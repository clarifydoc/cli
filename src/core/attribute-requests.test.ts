import { describe, expect, it } from "vitest";
import { createEmptyAnalysis, type FileAnalysis } from "../types/analysis.js";
import { applyAttributeRequests } from "./attribute-requests.js";

function page(): FileAnalysis {
  const a = createEmptyAnalysis("templates/club.tmpl", "gotemplate");
  a.interactiveElements = [
    { element: "button", event: "click", handler: "request_clubs_transfer", line: 2, request: { method: "", target: "/clubs/transfer", attribute: "data-url" } },
    { element: "button", event: "click", handler: "request_clubs_tooltip", line: 3, request: { method: "", target: "/clubs/tooltip", attribute: "data-tooltip-url" } },
  ];
  a.dataSources = [
    { kind: "api-call", name: "/clubs/transfer", target: "/clubs/transfer", urlAttribute: "data-url", calls: [], line: 2 },
    { kind: "api-call", name: "/clubs/tooltip", target: "/clubs/tooltip", urlAttribute: "data-tooltip-url", calls: [], line: 3 },
  ];
  a.functions = [2, 3].map((line) => ({ name: line === 2 ? "request_clubs_transfer" : "request_clubs_tooltip", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine: line }));
  return a;
}

describe("requests through a URL in a markup attribute", () => {
  it("keeps a request a script reads, with the verb its readers agree on, and drops one nothing reads", () => {
    const template = page();
    const script = { ...createEmptyAnalysis("web/fetch-action.ts", "typescript"), attributeReads: [{ attribute: "data-url", method: "POST", line: 2 }, { attribute: "data-url", line: 9 }] };
    expect(applyAttributeRequests([template, script])).toEqual({ kept: 1, dropped: 1 });
    expect(template.interactiveElements.map((e) => e.request?.method ?? null)).toEqual(["POST", null]);
    expect(template.dataSources.map((d) => d.name)).toEqual(["POST /clubs/transfer"]);
    expect(template.functions.map((f) => f.name)).toEqual(["request_clubs_transfer"]);
  });

  it("names no verb when the readers name different ones", () => {
    const template = page();
    const a = { ...createEmptyAnalysis("web/a.ts", "typescript"), attributeReads: [{ attribute: "data-url", method: "POST", line: 1 }] };
    const b = { ...createEmptyAnalysis("web/b.ts", "typescript"), attributeReads: [{ attribute: "data-url", method: "DELETE", line: 1 }] };
    applyAttributeRequests([template, a, b]);
    expect(template.dataSources.map((d) => d.name)).toEqual(["/clubs/transfer"]);
  });
});
