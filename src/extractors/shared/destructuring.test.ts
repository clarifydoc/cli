import { describe, it, expect } from "vitest";
import { destructuredArrayProps, destructuredProps, patternBindings } from "./destructuring.js";

describe("destructuredProps", () => {
  it("names each top-level property with the local it binds", () => {
    expect([...destructuredProps("{ table, onRemove: remove, onSave = () => {}, 'on-pick': pick, club: { id }, ...rest }")]).toEqual([
      ["table", "table"],
      ["onRemove", "remove"],
      ["onSave", "onSave"],
      ["on-pick", "pick"],
      ["club", null],
    ]);
  });

  it("reads a default holding commas, arrows and comparisons as the default", () => {
    expect([...destructuredProps("{ label = 'Home, away', pick: choose = (a, b) => a >= b, size }")]).toEqual([
      ["label", "label"],
      ["pick", "choose"],
      ["size", "size"],
    ]);
  });

  it("reads anything but an object pattern as none", () => {
    expect(destructuredProps("props").size).toBe(0);
    expect(destructuredProps("[first, second]").size).toBe(0);
  });
});

describe("patternBindings", () => {
  it("binds the locals, never the keys read or the names defaults use", () => {
    expect(patternBindings("{ boot, refresh: again, onSave = noop, club: { id, crest: badge }, ...rest }")).toEqual(["boot", "again", "onSave", "id", "badge", "rest"]);
    expect(patternBindings("[first, , { name } = {}, ...others]")).toEqual(["first", "name", "others"]);
  });

  it("refuses what is no destructuring pattern of that shape", () => {
    expect(patternBindings("club")).toBeNull();
    expect(patternBindings("{:keys [a b]}")).toBeNull();
    expect(patternBindings("[a b]")).toBeNull();
  });
});

describe("destructuredArrayProps", () => {
  it("names the locals of each array-pattern property by position", () => {
    expect([...destructuredArrayProps("{ pair: [table, , setTable], n, 'tuple': [a = 1, { b }, ...rest], club: { id }, ...others }")]).toEqual([
      ["pair", ["table", null, "setTable"]],
      ["tuple", ["a", null, null]],
    ]);
  });

  it("reads anything but an object pattern as none", () => {
    expect(destructuredArrayProps("[first, second]").size).toBe(0);
    expect(destructuredArrayProps("{ pair }").size).toBe(0);
  });
});
