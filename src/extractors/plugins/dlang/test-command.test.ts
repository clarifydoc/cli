import { describe, expect, it } from "vitest";
import { dubTestCommand } from "./test-command.js";

const none = { packages: new Set<string>(), manifests: new Set<string>() };

describe("D test command", () => {
  it("a dub package's unittest blocks run with dub test", () => {
    expect(dubTestCommand([{ file: "source/league.d", names: ["unittest at line 3"] }], { ...none, manifests: new Set(["dub.sdl"]) })).toBe("dub test");
    expect(dubTestCommand([{ file: "source/league.d", names: [] }], { ...none, manifests: new Set(["dub.json"]) })).toBe("dub test");
  });

  it("a file outside any package is compiled with -unittest and run by itself", () => {
    expect(dubTestCommand([{ file: "b.d", names: [] }, { file: "a.d", names: [] }], none)).toBe("dmd -unittest -main -run a.d && dmd -unittest -main -run b.d");
  });
});
