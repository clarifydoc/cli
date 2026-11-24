import { describe, expect, it } from "vitest";
import { dropTypeArguments, singleCall } from "./locals.js";

describe("Go explicit type arguments on a call", () => {
  it("drops a type-argument list written as types", () => {
    expect(dropTypeArguments("NewBox[int]()")).toBe("NewBox()");
    expect(dropTypeArguments("league.NewPair[string, *Club](a)")).toBe("league.NewPair(a)");
    expect(dropTypeArguments("NewIndex[map[string]Club]()")).toBe("NewIndex()");
    expect(singleCall("NewBox[Player]()")).toBe("NewBox()");
  });

  it("keeps an index expression that is called", () => {
    expect(dropTypeArguments("handlers[kind]()")).toBe("handlers[kind]()");
    expect(dropTypeArguments("fns[0]()")).toBe("fns[0]()");
    expect(singleCall("handlers[kind]()")).toBeNull();
  });
});
