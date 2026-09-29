import { describe, it, expect, vi } from "vitest";
import { extractJsightRoutes, extractJsightTypes, parseJsightObject } from "./index.js";
import { jsightMeta } from "./meta.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// The core pass asks the registry for the plugin's hooks; answer with this
// plugin's meta directly so the test loads nothing outside the folder.
vi.mock("../../registry.js", () => ({ pluginFor: () => jsightMeta }));

/**
 * JSight API-description files are the only in-repo statement of the API
 * surface for contract-first services (the resource classes implement
 * interfaces from an external artifact and carry no routing annotations).
 */
describe("JSight route extraction", () => {
  it("extracts one api route per unindented VERB /path line", () => {
    const src = `JSIGHT 0.3

GET /find-persons
  Query "search=xxx"
  200
    @PersonDataResponse

POST /organisation-tree
  Request @OrganisationTreeRequest
  200
    @OrganisationTreeHierarchy

GET /universal-entities
  Query "type=xxx&term=xxx&cursor=xxx&limit=20"
  200
    @UniversalEntityLookupResult
`;
    const routes = extractJsightRoutes(src.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /find-persons",
      "POST /organisation-tree",
      "GET /universal-entities",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
    expect(routes[0]!.line).toBe(3);
  });

  it("ignores indented schema detail and non-endpoint lines", () => {
    const src = `JSIGHT 0.3
TYPE @Person
  {
    "id": "uuid"
  }
  GET /not-a-route-indented
`;
    expect(extractJsightRoutes(src.split("\n"))).toEqual([]);
  });
});

// ─── Route attribute layer (params) ───────────────────────────────────────────

const SPEC = `JSIGHT 0.3

GET /orders
  Query "status=open&limit=20"
  200
    [@Order]

POST /orders
  Request @CreateOrderRequest
  201
    @Order

GET /orders/{id}
  Path
    {
      "id": 42 // {type: "integer"}
    }
  Headers
    {
      "X-Tenant": "acme"
    }
  200
    @Order

PUT /orders/{id}/lines/{lineId}
  Query @LineFilter
  Request
    Headers
      {
        "If-Match": "etag"
      }
    Body
      {
        "quantity": 2
      }
  200
    Headers
      {
        "X-Not-A-Request-Header": "x"
      }
    @Order

URL /orders/{id}/notes
  GET
    Query { "page": 1 }
    200 [@Note]
  POST
    Request [@Note]
    201 @Note

TYPE @Order
  {
    "id": 42,
    "status": "open", // {type: "enum"}
    "total": 99.5,
    "createdAt": "2024-01-01T00:00:00Z", // {type: "datetime"}
    "lines": [@OrderLine],
    "meta": {
      "nested": "skipped"
    },
    "tags": [
      "a"
    ]
  }

TYPE @OrderLine
  {
    "sku": "A-1",
    "quantity": 2,
    "note": "gift" // {optional: true}
  }

TYPE @CreateOrderRequest
  {
    "customerId": "3b241101-e2bb-4255-8caf-4136c566a962", // {type: "uuid"}
    "lines": [@OrderLine],
    "coupon": "SPRING", // {optional: true}
    "shipTo": @Address // {optional: true}
  }

TYPE @Address
  {
    "street": "Main 1"
  }

TYPE @Note @OrderLine
`;

describe("JSight endpoint blocks as route params", () => {
  const routes = extractJsightRoutes(SPEC.split("\n"));
  const byPath = (m: string, p: string) => routes.find((r) => r.httpMethod === m && r.path === p)!;

  it("reads Query strings, Path objects and Headers", () => {
    expect(byPath("GET", "/orders").params).toEqual([
      { name: "status", type: null, binding: "query" },
      { name: "limit", type: null, binding: "query" },
    ]);
    expect(byPath("GET", "/orders/{id}").params).toEqual([
      { name: "id", type: "integer", binding: "route" },
      { name: "X-Tenant", type: "string", binding: "header" },
    ]);
  });

  it("types the body from `Request @Type`", () => {
    expect(byPath("POST", "/orders").params).toEqual([{ name: "body", type: "CreateOrderRequest", binding: "body" }]);
  });

  it("reads nested Request Headers/Body, a typed Query, and skips response blocks", () => {
    expect(byPath("PUT", "/orders/{id}/lines/{lineId}").params).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "lineId", type: null, binding: "route" },
      { name: "query", type: "LineFilter", binding: "query" },
      { name: "If-Match", type: "string", binding: "header" },
      { name: "body", type: "object", binding: "body" },
    ]);
  });

  it("expands a URL block into one route per nested verb", () => {
    expect(byPath("GET", "/orders/{id}/notes").params).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "page", type: "integer", binding: "query" },
    ]);
    expect(byPath("POST", "/orders/{id}/notes").params).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "body", type: "Note[]", binding: "body" },
    ]);
  });

  it("never marks a contract-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("JSight TYPE blocks as classes", () => {
  const types = extractJsightTypes(SPEC.split("\n"));
  const cls = (n: string) => types.find((t) => t.name === n)!;
  const prop = (c: string, n: string) => cls(c).properties.find((p) => p.name === n)!;

  it("emits one class per TYPE with typed, required-by-default properties", () => {
    expect(types.map((t) => t.name)).toEqual(["Order", "OrderLine", "CreateOrderRequest", "Address", "Note"]);
    expect(cls("Order").decorators).toEqual(["jsight"]);
    expect(prop("Order", "id")).toMatchObject({ type: "integer", isRequired: true });
    expect(prop("Order", "total").type).toBe("number");
    expect(prop("Order", "status").type).toBe("string");
    expect(prop("Order", "createdAt").type).toBe("string(date-time)");
    expect(prop("Order", "lines").type).toBe("OrderLine[]");
    expect(prop("Order", "meta").type).toBe("object");
    expect(prop("Order", "tags").type).toBe("string[]");
    expect(cls("Order").properties.map((p) => p.name)).not.toContain("nested");
  });

  it("clears isRequired on `{optional: true}` and reads `@Ref` values", () => {
    expect(prop("CreateOrderRequest", "customerId").type).toBe("string(uuid)");
    expect(prop("CreateOrderRequest", "coupon").isRequired).toBeUndefined();
    expect(prop("CreateOrderRequest", "shipTo")).toMatchObject({ type: "Address" });
    expect(prop("CreateOrderRequest", "shipTo").isRequired).toBeUndefined();
  });

  it("reads an alias TYPE as inheritance", () => {
    expect(cls("Note").extends).toBe("OrderLine");
    expect(cls("Note").properties).toEqual([]);
  });

  it("parses object keys with strings containing `//` and brackets intact", () => {
    const props = parseJsightObject([`{`, `  "url": "http://x/{a}", // {type: "uri"}`, `  "n": 1`, `}`]);
    expect(props).toEqual([
      { name: "url", type: "string(uri)", optional: false },
      { name: "n", type: "integer", optional: false },
    ]);
  });
});

describe("JSight request schema through the core pass", () => {
  it("flattens the body TYPE with nested refs, arrays and optionals", () => {
    const lines = SPEC.split("\n");
    const analysis = createEmptyAnalysis("api.jsight", "jsight");
    analysis.projectId = "root";
    analysis.classes = extractJsightTypes(lines);
    const routes = extractJsightRoutes(lines).map((r) => ({ ...r, filePath: "api.jsight", projectId: "root" }));
    attachRequestSchemas(routes, [analysis]);
    const create = routes.find((r) => r.httpMethod === "POST" && r.path === "/orders") as typeof routes[number] & { requestSchema?: unknown };
    expect(create.requestSchema).toEqual({
      type: "object",
      properties: {
        customerId: { type: "string", format: "uuid" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, quantity: { type: "integer" }, note: { type: "string" } },
            required: ["sku", "quantity"],
          },
        },
        coupon: { type: "string" },
        shipTo: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
      },
      required: ["customerId", "lines"],
    });
    const notes = routes.find((r) => r.httpMethod === "POST" && r.path === "/orders/{id}/notes") as typeof routes[number] & { requestSchema?: { type?: string } };
    expect(notes.requestSchema?.type).toBe("array");
  });

  it("maps the hooks directly", async () => {
    const { jsightRequestSchema: h } = await import("./request-schema.js");
    expect(h.describeType("string(email)")).toEqual({ kind: "scalar", schema: { type: "string", format: "email" } });
    expect(h.describeType("boolean")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("Order[]")).toEqual({ kind: "array", element: "Order" });
    expect(h.describeType("any")).toEqual({ kind: "any" });
    expect(h.describeType("Order")).toEqual({ kind: "object", name: "Order" });
  });
});
