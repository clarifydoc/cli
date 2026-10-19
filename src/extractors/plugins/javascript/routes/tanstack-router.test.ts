import { describe, expect, it } from "vitest";
import { tanstackPath } from "./tanstack-router.js";

describe("tanstackPath", () => {
  it("writes TanStack path syntax the way the route map does", () => {
    expect(tanstackPath("/posts/$postId")).toBe("/posts/:postId");
    expect(tanstackPath("/files/$")).toBe("/files/*");
    expect(tanstackPath("/_auth/dashboard")).toBe("/dashboard");
    expect(tanstackPath("/(marketing)/pricing")).toBe("/pricing");
    expect(tanstackPath("/settings/")).toBe("/settings");
    expect(tanstackPath("/shop/{-$lang}/cart")).toBe("/shop/:lang?/cart");
    expect(tanstackPath("/")).toBe("/");
  });
});
