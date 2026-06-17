import { describe, it, expect } from "vitest";
import { isRoutePath } from "./express.js";

/**
 * Guards the path-shape filter that stops `.get()`-shaped calls that aren't
 * routes from leaking into the inbound-routes table. Regression: a jQuery
 * plugin's `options.get('minSpotColor')` and Cypress `cy.get('button')` were
 * reported as `GET <string>` endpoints.
 */
describe("isRoutePath", () => {
  it.each(["/", "/users", "/users/:id", "/api/v1/orders", "*", "/*", "/users/${id}"])(
    "accepts route-shaped path %j",
    (p) => expect(isRoutePath(p)).toBe(true),
  );

  it.each([
    "minSpotColor", // jquery.sparkline options.get(...)
    "numberFormatter",
    "button", // Cypress cy.get(...)
    "input[name=user]",
    ".multiselect__tags",
    "etag", // res.get('etag')
    "content-type",
    "",
  ])("rejects non-route string %j", (p) => expect(isRoutePath(p)).toBe(false));
});
