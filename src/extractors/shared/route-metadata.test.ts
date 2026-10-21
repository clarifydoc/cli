import { describe, it, expect } from "vitest";
import { pathParamTokens } from "./route-metadata.js";

describe("pathParamTokens", () => {
  it("reads every spelling of a path parameter, hyphenated names whole", () => {
    expect(pathParamTokens("/cars/{car-id}/parts/{id:int}/:sku/<int:pk>/{**rest}")).toEqual(["car-id", "id", "rest", "sku", "pk"]);
  });
});
