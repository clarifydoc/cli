import { describe, it, expect } from "vitest";
import { evalGoBuildExpr, goDefaultBuildExclusion } from "./build-constraints.js";

describe("Go build constraints for the default (Linux/amd64) build", () => {
  it("evaluates //go:build expressions, undecided on a tag the target does not fix", () => {
    expect(evalGoBuildExpr("windows")).toBe(false);
    expect(evalGoBuildExpr("!windows")).toBe(true);
    expect(evalGoBuildExpr("linux && amd64")).toBe(true);
    expect(evalGoBuildExpr("darwin || freebsd")).toBe(false);
    expect(evalGoBuildExpr("unix && !(arm64 || 386)")).toBe(true);
    expect(evalGoBuildExpr("integration")).toBeNull();
    expect(evalGoBuildExpr("windows && integration")).toBe(false);
    expect(evalGoBuildExpr("linux || integration")).toBe(true);
  });

  it("reads the header and the file name", () => {
    const pkg = "package garage\n\nfunc Park() {}\n";
    expect(goDefaultBuildExclusion(`// Licence text.\n\n//go:build windows\n\n${pkg}`, "garage/disk.go")).toBe("//go:build windows");
    expect(goDefaultBuildExclusion(`//go:build !windows\n\n${pkg}`, "garage/disk_unix.go")).toBeNull();
    expect(goDefaultBuildExclusion(pkg, "garage/lift_darwin.go")).toBe("file name _darwin");
    expect(goDefaultBuildExclusion(pkg, "garage/lift_windows_amd64_test.go")).toBe("file name _windows_amd64");
    expect(goDefaultBuildExclusion(pkg, "garage/lift_linux.go")).toBeNull();
    expect(goDefaultBuildExclusion(pkg, "garage/car_park.go")).toBeNull();
    expect(goDefaultBuildExclusion(`// +build darwin freebsd\n\n${pkg}`, "garage/disk.go")).toBe("// +build darwin freebsd");
    expect(goDefaultBuildExclusion(`//go:build integration\n\n${pkg}`, "garage/disk.go")).toBeNull();
    // After the package clause a constraint is only a comment.
    expect(goDefaultBuildExclusion(`${pkg}//go:build windows\n`, "garage/disk.go")).toBeNull();
  });
});
