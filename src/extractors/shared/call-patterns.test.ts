import { describe, it, expect } from "vitest";
import { isDatabaseCall, registerCallPatterns } from "./call-patterns.js";

describe("isDatabaseCall", () => {
  registerCallPatterns("java", undefined, ["JdbcTemplate", "entityManager", "session", "repository"]);

  it("reads a datastore method on an unknown receiver", () => {
    expect(isDatabaseCall("clubDao.findByName", "java")).toBe(true);
    expect(isDatabaseCall("entityManager.get", "java")).toBe(true);
  });

  it("does not take a cache or a bag of values for a datastore (real-repo FP)", () => {
    for (const call of ["effectiveCache.get", "bundleCache.getAll", "claims.get", "includedEmbeddedCollections.get", "requestHeaders.get"]) {
      expect(isDatabaseCall(call, "java")).toBe(false);
    }
  });
});
