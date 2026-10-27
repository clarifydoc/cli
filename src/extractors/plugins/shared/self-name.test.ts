import { describe, it, expect } from "vitest";
import { cargoPackageManager } from "../rust/package-manifests.js";
import { goPackageManager } from "../go/package-manifests.js";
import { npmPackageManager } from "../javascript/package-manifests.js";

/** `PackageManifestSpec.selfName`: the package a manifest declares for itself. */
describe("manifest self names", () => {
  it("reads Cargo [package] name, not a workspace-only manifest", () => {
    const cargo = cargoPackageManager.manifests[0]!;
    expect(cargo.selfName!(`[package]\nname = "league_db_views_site"\nversion.workspace = true\n\n[dependencies]\nname = "x"`)).toBe("league_db_views_site");
    expect(cargo.selfName!(`[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nname = "nope"`)).toBeNull();
  });
  it("reads go.mod module and package.json name", () => {
    expect(goPackageManager.manifests[0]!.selfName!(`module code.example.com/league\n\ngo 1.22\n`)).toBe("code.example.com/league");
    expect(npmPackageManager.manifests[0]!.selfName!(`{ "name": "@acme/ui", "version": "1.0.0" }`)).toBe("@acme/ui");
    expect(npmPackageManager.manifests[0]!.selfName!(`{ "private": true }`)).toBeNull();
  });
});
