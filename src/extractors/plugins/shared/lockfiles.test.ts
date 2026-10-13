import { describe, it, expect } from "vitest";
import { parseComposerLock, parsePackageLock, parsePipfileLock, parsePnpmLock, parseTomlPackageLock, parseYarnLock } from "./lockfiles.js";

describe("lockfile readers", () => {
  it("npm package-lock v3: top-level installs, scoped included, nested copies left out", () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {
      "": { name: "app" },
      "node_modules/lodash": { version: "4.17.15" },
      "node_modules/@scope/pkg": { version: "1.2.3" },
      "node_modules/a/node_modules/lodash": { version: "3.0.0" },
    } });
    expect([...parsePackageLock(lock)]).toEqual([["lodash", "4.17.15"], ["@scope/pkg", "1.2.3"]]);
    expect([...parsePackageLock(JSON.stringify({ dependencies: { axios: { version: "0.21.1" } } }))]).toEqual([["axios", "0.21.1"]]);
  });

  it("yarn.lock: each range of a package resolves to its version", () => {
    const lock = ['"@babel/core@^7.0.0", "@babel/core@^7.1.0":', '  version "7.22.5"', "", "lodash@^4.17.0:", "  version \"4.17.21\""].join("\n");
    expect([...parseYarnLock(lock)]).toEqual([["@babel/core", "7.22.5"], ["lodash", "4.17.21"]]);
  });

  it("Cargo.lock / poetry.lock / uv.lock: [[package]] blocks; a name locked twice has no one version", () => {
    const lock = ['[[package]]', 'name = "serde"', 'version = "1.0.190"', "", '[[package]]', 'name = "syn"', 'version = "1.0.109"', "", '[[package]]', 'name = "syn"', 'version = "2.0.39"'].join("\n");
    expect([...parseTomlPackageLock(lock)]).toEqual([["serde", "1.0.190"]]);
  });

  it("composer.lock and Pipfile.lock", () => {
    expect([...parseComposerLock(JSON.stringify({ packages: [{ name: "laravel/framework", version: "v10.48.4" }], "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.1" }] }))])
      .toEqual([["laravel/framework", "10.48.4"], ["phpunit/phpunit", "10.5.1"]]);
    expect([...parsePipfileLock(JSON.stringify({ default: { Django: { version: "==4.2.7" } }, develop: { pytest: { version: "==7.4.3" } } }))])
      .toEqual([["django", "4.2.7"], ["pytest", "7.4.3"]]);
  });

  it("pnpm-lock.yaml v9 (root importer only) and v5", () => {
    const v9 = ["lockfileVersion: '9.0'", "importers:", "  .:", "    dependencies:", "      vue:", "        specifier: ^3.4.0", "        version: 3.4.21(typescript@5.3.3)",
      "    devDependencies:", "      '@nuxt/kit':", "        specifier: ^3.0.0", "        version: 3.10.3", "  packages/other:", "    dependencies:", "      lodash:", "        specifier: ^4", "        version: 4.17.21", "packages:", "  vue@3.4.21:", "    resolution: {}"].join("\n");
    expect([...parsePnpmLock(v9)]).toEqual([["vue", "3.4.21"], ["@nuxt/kit", "3.10.3"]]);
    expect([...parsePnpmLock(["lockfileVersion: 5.4", "dependencies:", "  axios: 0.21.1", "devDependencies:", "  vitest: 1.0.0_vite@5.0.0"].join("\n"))]).toEqual([["axios", "0.21.1"], ["vitest", "1.0.0"]]);
  });
});
