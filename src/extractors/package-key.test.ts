import { describe, it, expect } from "vitest";
import { packageKeyOf } from "./registry.js";

describe("packageKeyOf", () => {
  it("keys a name the way its ecosystem compares names", () => {
    expect(packageKeyOf("pypi", "Club_Stats")).toBe(packageKeyOf("pypi", "club-stats"));
    expect(packageKeyOf("cargo", "league_core")).toBe("league-core");
    expect(packageKeyOf("npm", "@league/Ui")).toBe("@league/ui");
  });
});
