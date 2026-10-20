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
    expect(got["0"]).toEqual({ name: "src/orders", slug: "src-orders", subsystem: "src/orders", system: "api", nameBasis: "folder" });
    expect(got["1"]).toEqual({ name: "src/pages", slug: "src-pages", subsystem: "src/pages", system: "web", nameBasis: "folder" });
    expect(got["2"]!.name).toBe("src/orders (x)");
    expect(got["2"]!.slug).toBe("src-orders-x");
    expect(got["3"]!.name).toBe("a + b");
  });
});

describe("nameCommunities — what folders do not say", () => {
  it("falls back to the routes' shared prefix, then the entity the code reaches, and says which rule named it", () => {
    const got = nameCommunities(
      {
        "0": ["a/orders.ts", "b/orders-db.ts"],
        "1": ["c/report.ts", "d/report-sql.ts"],
        "2": ["e/x.ts", "f/y.ts"],
        "3": ["src/billing/a.ts", "src/billing/b.ts"],
      },
      {
        routes: [{ filePath: "a/orders.ts", path: "/api/orders" }, { filePath: "a/orders.ts", path: "/api/orders/:id/lines" }, { filePath: "a/orders.ts", path: "/health" }],
        access: [{ file: "c/report.ts", entity: "Invoice" }, { file: "d/report-sql.ts", entity: "Invoice" }, { file: "d/report-sql.ts", entity: "Customer" }],
      },
    );
    expect([got["0"]!.name, got["0"]!.nameBasis]).toEqual(["/api/orders", "routes"]);
    expect([got["1"]!.name, got["1"]!.nameBasis]).toEqual(["Invoice", "entity"]);
    expect(got["2"]!.nameBasis).toBe("folders");
    expect([got["3"]!.name, got["3"]!.nameBasis]).toEqual(["src/billing", "folder"]);
  });

  it("names the group above, and marks a community nothing links to that serves nothing", async () => {
    const { groupCommunities } = await import("./community-detector.js");
    const communities = {
      "0": ["src/orders/a.ts", "src/orders/b.ts"],
      "1": ["src/orders/c.ts", "src/orders/d.ts"],
      "2": ["src/users/a.ts", "src/users/b.ts"],
      "3": ["src/users/c.ts", "src/users/d.ts"],
      "4": ["scripts/old.ts", "scripts/older.ts"],
    };
    const link = (source: string, target: string, proximity = 1) => ({ source, target, proximity }) as never;
    const links = [
      link("src/orders/a.ts", "src/orders/b.ts"), link("src/orders/c.ts", "src/orders/d.ts"),
      link("src/users/a.ts", "src/users/b.ts"), link("src/users/c.ts", "src/users/d.ts"),
      // Strong ties within orders and within users; one weak tie across.
      link("src/orders/a.ts", "src/orders/c.ts"), link("src/orders/b.ts", "src/orders/d.ts"),
      link("src/users/a.ts", "src/users/c.ts"), link("src/users/b.ts", "src/users/d.ts"),
      link("src/orders/a.ts", "src/users/a.ts", 3),
    ];
    const groups = groupCommunities(links, communities);
    expect(groups["0"]).toBe(groups["1"]);
    expect(groups["2"]).toBe(groups["3"]);
    expect(groups["0"]).not.toBe(groups["2"]);
    const got = nameCommunities(communities, { groups, links, anchors: new Set(["src/users/a.ts"]) });
    expect(got["0"]!.group).toBe("src/orders");
    expect(got["2"]!.group).toBe("src/users");
    expect(got["4"]!.group).toBeUndefined();
    expect(got["4"]!.orphan).toBe(true);
    expect(got["0"]!.orphan).toBeUndefined();
    expect(groupCommunities(links, { "0": ["a"], "1": ["b"], "2": ["c"] })).toEqual({});
  });
});
