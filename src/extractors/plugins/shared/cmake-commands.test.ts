import { describe, expect, it } from "vitest";
import { cmakeProjectCommands, ctestCommand } from "./cmake-commands.js";
import type { ProjectRootView } from "../../../types/language-plugin.js";

const root = (files: Record<string, string>): ProjectRootView => ({ entries: Object.keys(files), read: (r) => files[r], exists: (r) => r in files });
const ctx = (source: string) => ({ packages: new Set<string>(), manifests: new Set<string>(), projectTests: [{ command: "ctest --test-dir build --output-on-failure", source }] });

describe("CMake project commands", () => {
  it("builds out of source; tests only when the root registers tests", () => {
    expect(cmakeProjectCommands(root({ "CMakeLists.txt": "project(League)\nadd_executable(club club.c)" })).map((c) => c.kind)).toEqual(["build"]);
    expect(cmakeProjectCommands(root({ "CMakeLists.txt": "project(League)\nenable_testing()" })).map((c) => c.kind)).toEqual(["build", "test"]);
    expect(cmakeProjectCommands(root({ "CMakeLists.txt": "# enable_testing()\nproject(League)" })).map((c) => c.kind)).toEqual(["build"]);
    expect(cmakeProjectCommands(root({}))).toEqual([]);
  });
});

describe("CTest command", () => {
  it("filters by name when the tests are discovered by their own names", () => {
    const tests = [{ file: "tests/club_test.cpp", names: ["ClubTest.Creates", "ClubTest.Saves"] }];
    expect(ctestCommand(tests, ctx("CMakeLists.txt gtest_discover_tests"))).toBe("ctest --test-dir build -R '^(ClubTest\\.Creates|ClubTest\\.Saves)$'");
  });

  it("runs the whole suite when names are the project's own registrations or not of the Suite.Case shape", () => {
    const tests = [{ file: "tests/club_test.cpp", names: ["ClubTest.Creates"] }];
    expect(ctestCommand(tests, ctx("CMakeLists.txt"))).toBe("ctest --test-dir build --output-on-failure");
    expect(ctestCommand([{ file: "tests/a.cpp", names: ["TEST"] }], ctx("CMakeLists.txt gtest_discover_tests"))).toBe("ctest --test-dir build --output-on-failure");
  });

  it("says nothing without a CTest project", () => {
    expect(ctestCommand([{ file: "tests/a.cpp", names: [] }], { packages: new Set(), manifests: new Set() })).toBeNull();
  });
});
