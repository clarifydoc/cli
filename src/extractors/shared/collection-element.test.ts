import { describe, it, expect } from "vitest";
import { collectionElementText } from "./collection-element.js";

describe("collectionElementText", () => {
  it("reads the element of a declared collection type, in any of the languages' spellings", () => {
    for (const [type, element] of [
      ["Club[]", "Club"], ["Array<Club>", "Club"], ["readonly Club[]", "Club"], ["list[Club]", "Club"], ["List<Club>", "Club"],
      ["IEnumerable<Club>", "Club"], ["[]*Club", "Club"], ["[]Club", "Club"], ["Optional[Sequence[Club]]", "Club"],
      ["set[Club] | None", "Club"], ["tuple[Club, ...]", "Club"], ["List<League.Club>", "League.Club"],
    ] as const) expect(collectionElementText(type)).toBe(element);
  });

  it("refuses a map, a union, a plain type, a tuple of several types and a nested collection", () => {
    for (const type of ["Map<string, Club>", "dict[str, Club]", "Club", "Club | Car", "tuple[Club, League]", "Club[][]", "Optional<Club>", ""]) {
      expect(collectionElementText(type)).toBeNull();
    }
  });
});
