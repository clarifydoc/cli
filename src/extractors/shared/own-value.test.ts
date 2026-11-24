import { describe, it, expect } from "vitest";
import { ownValue } from "./own-value.js";

describe("ownValue", () => {
  it("answers a key the map states, and nothing for what a plain object inherits", () => {
    const fieldValues: Record<string, string> = { BASE: "/api/clubs" };
    expect(ownValue(fieldValues, "BASE")).toBe("/api/clubs");
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) expect(ownValue(fieldValues, key)).toBeUndefined();
    expect(ownValue(undefined, "BASE")).toBeUndefined();
  });

  it("answers a field the source itself names `constructor`", () => {
    const parsed = JSON.parse('{"constructor":"/api/garage"}') as Record<string, string>;
    expect(ownValue(parsed, "constructor")).toBe("/api/garage");
  });
});
