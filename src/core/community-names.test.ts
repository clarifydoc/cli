import { describe, expect, it } from "vitest";
import { nameCommunities } from "./community-names.js";

describe("nameCommunities", () => {
  it("names a community by the folder most of its files share, within its sub-project", () => {
    const got = nameCommunities(
      {
        "0": ["api/src/orders/a.ts", "api/src/orders/b.ts", "api/src/orders/c.ts", "api/src/util.ts"],
        "1": ["web/src/pages/Home.tsx", "web/src/pages/Cart.tsx", "web/src/components/Btn.tsx"],
        "2": ["api/src/orders/x.ts", "api/src/orders/y.ts"],
        "3": ["README.ts", "a/one.ts", "b/two.ts"],
      },
      {
        fileProjects: { "api/src/orders/a.ts": "api", "api/src/orders/b.ts": "api", "api/src/orders/c.ts": "api", "api/src/util.ts": "api", "web/src/pages/Home.tsx": "web", "web/src/pages/Cart.tsx": "web", "web/src/components/Btn.tsx": "web", "api/src/orders/x.ts": "api", "api/src/orders/y.ts": "api" },
        projects: [{ id: "api", name: "api", root: "api" }, { id: "web", name: "web", root: "web" }, { id: "root", name: "repo", root: "" }],
      },
    );
    expect(got["0"]).toEqual({ name: "src/orders", slug: "src-orders", subsystem: "src/orders", system: "api" });
    expect(got["1"]).toEqual({ name: "src/pages", slug: "src-pages", subsystem: "src/pages", system: "web" });
    expect(got["2"]!.name).toBe("src/orders (x)");
    expect(got["2"]!.slug).toBe("src-orders-x");
    expect(got["3"]!.name).toBe("a + b");
  });
});
