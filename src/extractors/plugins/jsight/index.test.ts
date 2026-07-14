import { describe, it, expect } from "vitest";
import { extractJsightRoutes } from "./index.js";

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

GET /club-entities
  Query "type=xxx&term=xxx&cursor=xxx&limit=20"
  200
    @ClubEntityLookupResult
`;
    const routes = extractJsightRoutes(src.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /find-persons",
      "POST /organisation-tree",
      "GET /club-entities",
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
