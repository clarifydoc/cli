import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyWorkspacePackages, clearWorkspacePackageCache, loadWorkspacePackages, namesWorkspacePackage } from "./workspace-packages.js";

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
      "packages/sdk/package.json": JSON.stringify({ name: "@league/sdk", main: "./build/index.js", exports: { ".": { types: "./build/index.d.ts", default: "./build/index.js" } } }),
      "packages/sdk/src/index.ts": "export * from './fetch-client';",
      "packages/sdk/src/fetch-errors.ts": "",
      "packages/ui/package.json": JSON.stringify({ name: "@app/ui", source: "lib/main.ts" }),
      "packages/ui/lib/main.ts": "",
      "web/package.json": JSON.stringify({ name: "web" }),
      "web/src/index.ts": "",
      "node_modules/x/package.json": JSON.stringify({ name: "x", main: "index.js" }),
      "node_modules/x/index.js": "",
    });
    const pkgs = loadWorkspacePackages(root);
    expect([...pkgs.keys()].sort()).toEqual(["@app/ui", "@league/sdk", "web"]);
    const from = join(root, "web/src/lib/a.ts");
    expect(applyWorkspacePackages("@league/sdk", from, pkgs, root)).toBe("packages/sdk/src/index");
    expect(applyWorkspacePackages("@app/ui", from, pkgs, root)).toBe("packages/ui/lib/main");
    expect(applyWorkspacePackages("@league/sdk/src/fetch-errors", from, pkgs, root)).toBe("packages/sdk/src/fetch-errors");
    expect(applyWorkspacePackages("lodash", from, pkgs, root)).toBe("lodash");
    // Inside the package itself, its own name is left to its own resolution.
    expect(applyWorkspacePackages("@league/sdk", join(root, "packages/sdk/src/x.ts"), pkgs, root)).toBe("@league/sdk");
  });
});

describe("workspace members", () => {
  beforeEach(() => clearWorkspacePackageCache());
  const kit = { "packages/kit/package.json": JSON.stringify({ name: "@league/kit", main: "src/index.ts" }), "packages/kit/src/index.ts": "" };
  const decoy = { "examples/kit/package.json": JSON.stringify({ name: "@league/kit", main: "index.ts" }), "examples/kit/index.ts": "" };

  it("break a name declared twice in favour of the package the workspace lists", () => {
    for (const manifest of <Array<Record<string, string>>>[
      { "package.json": JSON.stringify({ name: "league", workspaces: ["packages/*", "apps/*"] }) },
      { "package.json": JSON.stringify({ name: "league", workspaces: { packages: ["packages/**"] } }) },
      { "package.json": JSON.stringify({ name: "league" }), "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - \"!**/examples/**\"\n" },
    ]) {
      clearWorkspacePackageCache();
      const root = repo({ ...manifest, ...kit, ...decoy });
      const pkgs = loadWorkspacePackages(root);
      expect(applyWorkspacePackages("@league/kit", join(root, "apps/pitwall/src/main.ts"), pkgs, root)).toBe("packages/kit/src/index");
    }
  });

  it("leave a name declared twice with no single member unresolved, and say it names a package", () => {
    const root = repo({ "package.json": JSON.stringify({ name: "league" }), ...kit, ...decoy });
    const pkgs = loadWorkspacePackages(root);
    expect(pkgs.has("@league/kit")).toBe(false);
    expect(applyWorkspacePackages("@league/kit", join(root, "apps/a.ts"), pkgs, root)).toBe("@league/kit");
    expect(namesWorkspacePackage(root, "@league/kit/standings")).toBe(true);
    expect(namesWorkspacePackage(root, "lodash")).toBe(false);
  });
});

describe("workspace package exports", () => {
  beforeEach(() => clearWorkspacePackageCache());
  const root = () => repo({
    "package.json": JSON.stringify({ name: "league", workspaces: ["packages/*"] }),
    "packages/kit/package.json": JSON.stringify({
      name: "@league/kit",
      exports: {
        ".": { require: "./src/cjs/index.cjs", default: "./dist/index.js" },
        "./standings": { require: "./dist/standings.cjs", import: "./dist/table/standings.mjs" },
        "./rules/*": { default: "./dist/rules/*.js" },
        "./coach": { source: "./src/coach.ts", import: "./dist/coach-built.js" },
      },
    }),
    "packages/kit/src/index.ts": "",
    "packages/kit/src/cjs/index.cjs": "",
    "packages/kit/src/table/standings.mts": "",
    "packages/kit/src/standings.cts": "",
    "packages/kit/src/rules/offside.ts": "",
    "packages/kit/src/coach.ts": "",
  });

  it("map subpaths, exact and by pattern, before joining a directory, reading the import's own condition", () => {
    const r = root();
    const pkgs = loadWorkspacePackages(r);
    const from = join(r, "apps/pitwall/src/main.ts");
    expect(applyWorkspacePackages("@league/kit", from, pkgs, r)).toBe("packages/kit/src/index");
    expect(applyWorkspacePackages("@league/kit", from, pkgs, r, true)).toBe("packages/kit/src/cjs/index");
    expect(applyWorkspacePackages("@league/kit/standings", from, pkgs, r)).toBe("packages/kit/src/table/standings");
    expect(applyWorkspacePackages("@league/kit/standings", from, pkgs, r, true)).toBe("packages/kit/src/standings");
    expect(applyWorkspacePackages("@league/kit/rules/offside", from, pkgs, r)).toBe("packages/kit/src/rules/offside");
    expect(applyWorkspacePackages("@league/kit/coach", from, pkgs, r)).toBe("packages/kit/src/coach");
    // Nothing in the package answers: the import stays as written.
    expect(applyWorkspacePackages("@league/kit/transfers", from, pkgs, r)).toBe("@league/kit/transfers");
  });

  it("keep an installed registry version an importer pins, never one linked into the workspace", () => {
    const r = repo({
      "package.json": JSON.stringify({ name: "league", workspaces: ["packages/*", "apps/*"] }),
      "packages/kit/package.json": JSON.stringify({ name: "@league/kit", main: "src/index.ts" }),
      "packages/kit/src/index.ts": "",
      "apps/legacy/package.json": JSON.stringify({ name: "legacy", dependencies: { "@league/kit": "^1.2.0" } }),
      "apps/legacy/node_modules/@league/kit/package.json": JSON.stringify({ name: "@league/kit", version: "1.2.3" }),
      "apps/linked/package.json": JSON.stringify({ name: "linked", dependencies: { "@league/kit": "^2.0.0" } }),
      "apps/pinned/package.json": JSON.stringify({ name: "pinned", dependencies: { "@league/kit": "workspace:*" } }),
      "apps/pinned/node_modules/@league/kit/package.json": JSON.stringify({ name: "@league/kit", version: "9.9.9" }),
    });
    mkdirSync(join(r, "apps/linked/node_modules/@league"), { recursive: true });
    symlinkSync(join(r, "packages/kit"), join(r, "apps/linked/node_modules/@league/kit"), "dir");
    const pkgs = loadWorkspacePackages(r);
    expect(applyWorkspacePackages("@league/kit", join(r, "apps/legacy/src/old.ts"), pkgs, r)).toBe("@league/kit");
    expect(applyWorkspacePackages("@league/kit", join(r, "apps/linked/src/new.ts"), pkgs, r)).toBe("packages/kit/src/index");
    expect(applyWorkspacePackages("@league/kit", join(r, "apps/pinned/src/main.ts"), pkgs, r)).toBe("packages/kit/src/index");
  });
});
