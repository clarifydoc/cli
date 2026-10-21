import { describe, expect, it } from "vitest";
import { tanstackPath } from "./tanstack-router.js";

describe("tanstackPath", () => {
  it("writes TanStack path syntax the way the route map does", () => {
    expect(tanstackPath("/games/$gameId")).toBe("/games/:gameId");
    expect(tanstackPath("/files/$")).toBe("/files/*");
    expect(tanstackPath("/_auth/dashboard")).toBe("/dashboard");
    expect(tanstackPath("/(marketing)/pricing")).toBe("/pricing");
    expect(tanstackPath("/settings/")).toBe("/settings");
    expect(tanstackPath("/shop/{-$lang}/garage")).toBe("/shop/:lang?/garage");
    expect(tanstackPath("/")).toBe("/");
  });
});
