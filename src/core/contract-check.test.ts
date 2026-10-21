import { describe, it, expect } from "vitest";
import { checkContracts } from "./contract-check.js";
import type { ApiRouteLink, DataSourceInfo, JsonSchemaNode, RouteInfo } from "../types/analysis.js";

const link = (over: Partial<ApiRouteLink> = {}): ApiRouteLink => ({
  source: "web/api.ts", sourceLine: 5, method: "POST", url: "/api/players/${id}", target: "api/players.ts", targetLine: 12,
  handler: "create", routePath: "/api/players/:id", confidence: "EXTRACTED", ...over,
} as ApiRouteLink);
const call = (body: JsonSchemaNode): DataSourceInfo & { filePath: string } =>
  ({ kind: "api-call", name: "post", target: "/api/players/${id}", calls: [], line: 5, filePath: "web/api.ts", requestBody: body });
const route = (schema: JsonSchemaNode): RouteInfo & { filePath: string; requestSchema: JsonSchemaNode } => ({
  path: "/api/players/:id", httpMethod: "POST", kind: "api", handler: "create", calls: [], middleware: [], line: 12, filePath: "api/players.ts",
  params: [{ name: "id", type: "string", binding: "route" }, { name: "dto", type: "CreatePlayer", binding: "body" }], requestSchema: schema,
} as never);

const declared: JsonSchemaNode = {
  type: "object",
  properties: { email: { type: "string" }, age: { type: "integer" }, address: { type: "object", properties: { city: { type: "string" } } } },
  required: ["email", "age"],
};

describe("checkContracts", () => {
  it("reports missing, unknown and mistyped fields, nested ones dotted, path params never", () => {
    const sent: JsonSchemaNode = {
      type: "object",
      properties: { id: { type: "string" }, Email: { type: "string" }, nickname: { type: "string" }, address: { type: "object", properties: { city: { type: "integer" } } } },
    };
    const found = checkContracts([link()], [call(sent)], [route(declared)]);
    expect(found.map((f) => [f.kind, f.field, f.expected ?? "", f.actual ?? ""])).toEqual([
      ["unknown-field", "nickname", "", ""],
      ["type-mismatch", "address.city", "string", "integer"],
      ["missing-field", "age", "", ""],
    ]);
    expect(found[0]!.route).toEqual({ file: "api/players.ts", line: 12, path: "/api/players/:id" });
  });

  it("judges nothing it cannot know: an open body, an open schema, an untyped value, a guessed link", () => {
    const open: JsonSchemaNode = { type: "object", properties: { email: {} }, additionalProperties: true };
    expect(checkContracts([link()], [call(open)], [route(declared)])).toEqual([]);
    const fieldsOnly: JsonSchemaNode = { type: "object", properties: { email: { type: "string" } }, additionalProperties: true };
    expect(checkContracts([link()], [call({ type: "object", properties: { email: { type: "string" }, other: {} } })], [route(fieldsOnly)])).toEqual([]);
    expect(checkContracts([link({ confidence: "INFERRED" })], [call({ type: "object", properties: {} })], [route(declared)])).toEqual([]);
  });

  it("lets an integer bind a number and a string bind a formatted field", () => {
    const d: JsonSchemaNode = { type: "object", properties: { price: { type: "number" }, at: { type: "string", format: "date-time" } } };
    const s: JsonSchemaNode = { type: "object", properties: { price: { type: "integer" }, at: { type: "string" } } };
    expect(checkContracts([link()], [call(s)], [route(d)])).toEqual([]);
  });
});
