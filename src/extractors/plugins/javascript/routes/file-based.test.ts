import { describe, it, expect } from "vitest";
import { fileToRoutePath } from "./file-based.js";

describe("fileToRoutePath — unplugin-vue-router / vite-plugin-pages convention", () => {
  it("maps a flat page to a top-level path", () => {
    expect(fileToRoutePath("arbejdstidsregistrering.vue")).toBe("/arbejdstidsregistrering");
  });

  it("drops `index` segments to the parent path", () => {
    expect(fileToRoutePath("index.vue")).toBe("/");
    expect(fileToRoutePath("index/forside/index.vue")).toBe("/forside");
    expect(fileToRoutePath("index/vikar/index.vue")).toBe("/vikar");
  });

  it("converts [param] to a :param dynamic segment", () => {
    expect(fileToRoutePath("index/arbejdstidsregistrering/[externalId].vue")).toBe(
      "/arbejdstidsregistrering/:externalId",
    );
  });

  it("converts a segment mixing static text and a param", () => {
    expect(fileToRoutePath("index/fravaersoversigt/personfravaer-[externalId].vue")).toBe(
      "/fravaersoversigt/personfravaer-:externalId",
    );
    expect(fileToRoutePath("index/indstillinger/fravaerskodeadministration/delete-[externalId].vue")).toBe(
      "/indstillinger/fravaerskodeadministration/delete-:externalId",
    );
  });

  it("converts [[param]] to an optional :param?", () => {
    expect(fileToRoutePath("index/timeoversigt_[[personId]].vue")).toBe("/timeoversigt_:personId?");
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
    expect(fileToRoutePath("index/vikarkorps/tilgaengelighed/[vikarId]/gentagelser.vue")).toBe(
      "/vikarkorps/tilgaengelighed/:vikarId/gentagelser",
    );
  });
});
