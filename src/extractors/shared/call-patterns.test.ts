import { describe, it, expect } from "vitest";
import { dbRootRefused, isDatabaseCall, registerCallPatterns } from "./call-patterns.js";

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

describe("dbRootRefused", () => {
  it("reads only the declared DB roots, never an Object member named like a receiver", () => {
    registerCallPatterns("java", undefined, undefined, { session: /^Session$/ });
    expect(dbRootRefused("session", "KickoffSession", "java")).toBe(true);
    expect(dbRootRefused("session", "org.hibernate.Session", "java")).toBe(false);
    // `Supplier<E> constructor` → `constructor.get()`: no DB root, and no crash.
    expect(dbRootRefused("constructor", "Supplier<E>", "java")).toBe(false);
    expect(dbRootRefused("toString", "Club", "java")).toBe(false);
  });
});
