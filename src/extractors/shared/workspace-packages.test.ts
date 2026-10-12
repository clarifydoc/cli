import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyWorkspacePackages, clearWorkspacePackageCache, loadWorkspacePackages } from "./workspace-packages.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe("workspace packages", () => {
  beforeEach(() => clearWorkspacePackageCache());

  it("maps a package name to its source entry, build output read back to src/", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "monorepo" }),
      "packages/sdk/package.json": JSON.stringify({ name: "@immich/sdk", main: "./build/index.js", exports: { ".": { types: "./build/index.d.ts", default: "./build/index.js" } } }),
      "packages/sdk/src/index.ts": "export * from './fetch-client';",
      "packages/ui/package.json": JSON.stringify({ name: "@app/ui", source: "lib/main.ts" }),
      "packages/ui/lib/main.ts": "",
      "web/package.json": JSON.stringify({ name: "web" }),
      "web/src/index.ts": "",
      "node_modules/x/package.json": JSON.stringify({ name: "x", main: "index.js" }),
      "node_modules/x/index.js": "",
    });
    const pkgs = loadWorkspacePackages(root);
    expect([...pkgs.keys()].sort()).toEqual(["@app/ui", "@immich/sdk", "web"]);
    const from = join(root, "web/src/lib/a.ts");
    expect(applyWorkspacePackages("@immich/sdk", from, pkgs, root)).toBe("packages/sdk/src/index");
    expect(applyWorkspacePackages("@app/ui", from, pkgs, root)).toBe("packages/ui/lib/main");
    expect(applyWorkspacePackages("@immich/sdk/src/fetch-errors", from, pkgs, root)).toBe("packages/sdk/src/fetch-errors");
    expect(applyWorkspacePackages("lodash", from, pkgs, root)).toBe("lodash");
    // Inside the package itself, its own name is left to its own resolution.
    expect(applyWorkspacePackages("@immich/sdk", join(root, "packages/sdk/src/x.ts"), pkgs, root)).toBe("@immich/sdk");
  });
});
