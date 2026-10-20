import { describe, it, expect } from "vitest";
import { pathParamTokens } from "./route-metadata.js";

describe("pathParamTokens", () => {
  it("reads every spelling of a path parameter, hyphenated names whole", () => {
    expect(pathParamTokens("/orders/{order-id}/items/{id:int}/:sku/<int:pk>/{**rest}")).toEqual(["order-id", "id", "rest", "sku", "pk"]);
  });
});
