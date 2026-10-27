import { afterEach, describe, expect, it } from "vitest";
import { enableFeatures, featureEnabled, featureStamp } from "./feature-flags.js";
import { EXTRACTOR_VERSION, extractorStamp } from "./manifest.js";

const saved = process.env.CLARIFYDOC_FEATURES;
afterEach(() => {
  if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
  else process.env.CLARIFYDOC_FEATURES = saved;
});

describe("feature flags", () => {
  it("take each known feature's default when nothing is set, and a default run stamps the bare version", () => {
    delete process.env.CLARIFYDOC_FEATURES;
    expect(featureEnabled("antlr:go")).toBe(true);
    expect(featureEnabled("kickoff")).toBe(false);
    expect(featureStamp()).toBe("");
    expect(extractorStamp()).toBe(EXTRACTOR_VERSION);
  });

  it("switch a feature off with `-` or `no-`, the most specific name winning", () => {
    process.env.CLARIFYDOC_FEATURES = "no-antlr";
    expect(featureEnabled("antlr:go")).toBe(false);
    process.env.CLARIFYDOC_FEATURES = "-antlr, antlr:lua";
    expect(featureEnabled("antlr:go")).toBe(false);
    expect(featureEnabled("antlr:lua")).toBe(true);
    process.env.CLARIFYDOC_FEATURES = "antlr, -antlr:lua";
    expect(featureEnabled("antlr:go")).toBe(true);
    expect(featureEnabled("antlr:lua")).toBe(false);
  });

  it("stamp only what differs from the defaults, so a setting that changes nothing reuses the cache", () => {
    process.env.CLARIFYDOC_FEATURES = "antlr";
    expect(featureStamp()).toBe("");
    process.env.CLARIFYDOC_FEATURES = "ANTLR, no-antlr:lua";
    expect(featureStamp()).toBe("-antlr:lua");
    process.env.CLARIFYDOC_FEATURES = "no-antlr";
    expect(extractorStamp()).toBe(`${EXTRACTOR_VERSION}+-antlr`);
  });

  it("are added to by `analyze --feature`", () => {
    process.env.CLARIFYDOC_FEATURES = "antlr:lua";
    enableFeatures(["no-antlr:go"]);
    expect(process.env.CLARIFYDOC_FEATURES).toBe("antlr:lua,no-antlr:go");
    expect(featureEnabled("antlr:go")).toBe(false);
  });
});
