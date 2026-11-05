import { describe, expect, it } from "vitest";
import { zigTestCommand } from "./test-command.js";

const none = { packages: new Set<string>(), manifests: new Set<string>() };

describe("Zig test command", () => {
  it("runs the build's tests when the project has a package manifest", () => {
    expect(zigTestCommand([{ file: "src/league.zig", names: ["test ranks clubs"] }], { ...none, manifests: new Set(["build.zig.zon"]) })).toBe("zig build test");
  });

  it("without one, runs each file by itself, filtered to its one marked test", () => {
    expect(zigTestCommand([{ file: "src/league.zig", names: ["ranks clubs"], cases: [{ path: ["ranks clubs"], line: 4 }] }], none)).toBe('zig test src/league.zig --test-filter "ranks clubs"');
    expect(zigTestCommand([
      { file: "src/b.zig", names: [] },
      { file: "src/a.zig", names: ["x", "y"], cases: [{ path: ["x"], line: 1 }, { path: ["y"], line: 5 }] },
    ], none)).toBe("zig test src/a.zig && zig test src/b.zig");
  });

  it("a doctest filters by its declaration, an anonymous test not at all", () => {
    expect(zigTestCommand([{ file: "src/car.zig", names: ["test rank"], cases: [{ path: ["test rank"], line: 2 }] }], none)).toBe('zig test src/car.zig --test-filter "rank"');
    expect(zigTestCommand([{ file: "src/car.zig", names: [], cases: [{ path: ["test at line 9"], line: 9 }] }], none)).toBe("zig test src/car.zig");
  });
});
