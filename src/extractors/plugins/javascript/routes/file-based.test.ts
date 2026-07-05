import { describe, it, expect } from "vitest";
import { fileToRoutePath } from "./file-based.js";

describe("fileToRoutePath — unplugin-vue-router / vite-plugin-pages convention", () => {
  it("maps a flat page to a top-level path", () => {
    expect(fileToRoutePath("matchlog.vue")).toBe("/matchlog");
  });

  it("drops `index` segments to the parent path", () => {
    expect(fileToRoutePath("index.vue")).toBe("/");
    expect(fileToRoutePath("index/home/index.vue")).toBe("/home");
    expect(fileToRoutePath("index/substitute/index.vue")).toBe("/substitute");
  });

  it("converts [param] to a :param dynamic segment", () => {
    expect(fileToRoutePath("index/matchlog/[externalId].vue")).toBe(
      "/matchlog/:externalId",
    );
  });

  it("converts a segment mixing static text and a param", () => {
    expect(fileToRoutePath("index/injuryoverview/playerinjury-[externalId].vue")).toBe(
      "/injuryoverview/playerinjury-:externalId",
    );
    expect(fileToRoutePath("index/settings/injurycodeadmin/delete-[externalId].vue")).toBe(
      "/settings/injurycodeadmin/delete-:externalId",
    );
  });

  it("converts [[param]] to an optional :param?", () => {
    expect(fileToRoutePath("index/timesheet_[[personId]].vue")).toBe("/timesheet_:personId?");
  });

  it("converts catch-all [...all] and optional catch-all [[...all]]", () => {
    expect(fileToRoutePath("[...all].vue")).toBe("/:all+");
    expect(fileToRoutePath("[[...all]].vue")).toBe("/:all*");
  });

  it("keeps a literal dot in a segment", () => {
    expect(fileToRoutePath("index/rapport/configuration.[rapportConfigurationId].vue")).toBe(
      "/rapport/configuration.:rapportConfigurationId",
    );
  });

  it("handles deep nesting", () => {
    expect(fileToRoutePath("index/bench/availability/[substituteId]/rematches.vue")).toBe(
      "/bench/availability/:substituteId/rematches",
    );
  });
});
