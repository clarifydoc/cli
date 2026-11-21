import { beforeAll, describe, expect, it } from "vitest";
import { allPluginMetas, loadAllPlugins, manifestFor } from "./registry.js";

describe("statesModuleNames", () => {
  beforeAll(async () => {
    await loadAllPlugins();
  });

  it("is set on exactly the manifests whose plugin has the moduleNames hook", () => {
    const mismatched = allPluginMetas()
      .filter((m) => !!m.ast?.moduleNames !== !!manifestFor(m.language)?.statesModuleNames)
      .map((m) => m.language);
    expect(mismatched).toEqual([]);
  });
});
