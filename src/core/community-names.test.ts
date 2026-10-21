import { describe, expect, it } from "vitest";
import { nameCommunities } from "./community-names.js";

describe("nameCommunities", () => {
  it("names a community by the folder most of its files share, within its sub-project", () => {
    const got = nameCommunities(
      {
        "0": ["api/src/cars/a.ts", "api/src/cars/b.ts", "api/src/cars/c.ts", "api/src/util.ts"],
        "1": ["web/src/pages/Home.tsx", "web/src/pages/Garage.tsx", "web/src/components/Btn.tsx"],
        "2": ["api/src/cars/x.ts", "api/src/cars/y.ts"],
        "3": ["README.ts", "a/one.ts", "b/two.ts"],
      },
      {
        fileProjects: { "api/src/cars/a.ts": "api", "api/src/cars/b.ts": "api", "api/src/cars/c.ts": "api", "api/src/util.ts": "api", "web/src/pages/Home.tsx": "web", "web/src/pages/Garage.tsx": "web", "web/src/components/Btn.tsx": "web", "api/src/cars/x.ts": "api", "api/src/cars/y.ts": "api" },
        projects: [{ id: "api", name: "api", root: "api" }, { id: "web", name: "web", root: "web" }, { id: "root", name: "repo", root: "" }],
      },
    );
    expect(got["0"]).toEqual({ name: "src/cars", slug: "src-cars", subsystem: "src/cars", system: "api", nameBasis: "folder" });
    expect(got["1"]).toEqual({ name: "src/pages", slug: "src-pages", subsystem: "src/pages", system: "web", nameBasis: "folder" });
    expect(got["2"]!.name).toBe("src/cars (x)");
    expect(got["2"]!.slug).toBe("src-cars-x");
    expect(got["3"]!.name).toBe("a + b");
  });
});

describe("nameCommunities — what folders do not say", () => {
  it("falls back to the routes' shared prefix, then the entity the code reaches, and says which rule named it", () => {
    const got = nameCommunities(
      {
        "0": ["a/cars.ts", "b/cars-db.ts"],
        "1": ["c/report.ts", "d/report-sql.ts"],
        "2": ["e/x.ts", "f/y.ts"],
        "3": ["src/billing/a.ts", "src/billing/b.ts"],
      },
      {
        routes: [{ filePath: "a/cars.ts", path: "/api/cars" }, { filePath: "a/cars.ts", path: "/api/cars/:id/lines" }, { filePath: "a/cars.ts", path: "/health" }],
        access: [{ file: "c/report.ts", entity: "Bill" }, { file: "d/report-sql.ts", entity: "Bill" }, { file: "d/report-sql.ts", entity: "Driver" }],
      },
    );
    expect([got["0"]!.name, got["0"]!.nameBasis]).toEqual(["/api/cars", "routes"]);
    expect([got["1"]!.name, got["1"]!.nameBasis]).toEqual(["Bill", "entity"]);
    expect(got["2"]!.nameBasis).toBe("folders");
    expect([got["3"]!.name, got["3"]!.nameBasis]).toEqual(["src/billing", "folder"]);
  });

  it("names the group above, and marks a community nothing links to that serves nothing", async () => {
    const { groupCommunities } = await import("./community-detector.js");
    const communities = {
      "0": ["src/cars/a.ts", "src/cars/b.ts"],
      "1": ["src/cars/c.ts", "src/cars/d.ts"],
      "2": ["src/players/a.ts", "src/players/b.ts"],
      "3": ["src/players/c.ts", "src/players/d.ts"],
      "4": ["scripts/old.ts", "scripts/older.ts"],
    };
    const link = (source: string, target: string, proximity = 1) => ({ source, target, proximity }) as never;
    const links = [
      link("src/cars/a.ts", "src/cars/b.ts"), link("src/cars/c.ts", "src/cars/d.ts"),
      link("src/players/a.ts", "src/players/b.ts"), link("src/players/c.ts", "src/players/d.ts"),
      // Strong ties within cars and within players; one weak tie across.
      link("src/cars/a.ts", "src/cars/c.ts"), link("src/cars/b.ts", "src/cars/d.ts"),
      link("src/players/a.ts", "src/players/c.ts"), link("src/players/b.ts", "src/players/d.ts"),
      link("src/cars/a.ts", "src/players/a.ts", 3),
    ];
    const groups = groupCommunities(links, communities);
    expect(groups["0"]).toBe(groups["1"]);
    expect(groups["2"]).toBe(groups["3"]);
    expect(groups["0"]).not.toBe(groups["2"]);
    const got = nameCommunities(communities, { groups, links, anchors: new Set(["src/players/a.ts"]) });
    expect(got["0"]!.group).toBe("src/cars");
    expect(got["2"]!.group).toBe("src/players");
    expect(got["4"]!.group).toBeUndefined();
    expect(got["4"]!.orphan).toBe(true);
    expect(got["0"]!.orphan).toBeUndefined();
    expect(groupCommunities(links, { "0": ["a"], "1": ["b"], "2": ["c"] })).toEqual({});
  });
});
