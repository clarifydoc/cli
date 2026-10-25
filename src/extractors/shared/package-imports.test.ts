import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyPackageImports, clearTsconfigAliasCache } from "./tsconfig-aliases.js";

describe("package.json imports (#…)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "clarifydoc-pkgimports-"));
    await mkdir(join(root, "garage", "src", "db"), { recursive: true });
    await writeFile(join(root, "garage", "package.json"), JSON.stringify({
      name: "garage",
      imports: {
        "#db/*": "./src/db/*.js",
        "#config": { types: "./dist/config.d.ts", import: "./dist/config.js" },
        "#cars/*.js": "./src/cars/*.ts",
        "#http": "undici",
      },
    }));
    await writeFile(join(root, "garage", "src", "db", "clubs.ts"), "export function findClub() {}");
    await mkdir(join(root, "garage", "src", "cars"), { recursive: true });
    await writeFile(join(root, "garage", "src", "config.ts"), "export const config = {};");
    clearTsconfigAliasCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const importer = () => join(root, "garage", "src", "index.ts");

  it("maps a pattern key to the source file it names", () => {
    expect(applyPackageImports("#db/clubs", importer(), root)).toBe("garage/src/db/clubs");
    expect(applyPackageImports("#cars/engine.js", importer(), root)).toBe("garage/src/cars/engine.ts");
  });

  it("reads a conditional target and a build output back to its source", () => {
    expect(applyPackageImports("#config", importer(), root)).toBe("garage/src/config");
  });

  it("leaves another package's name and an unmapped specifier as written", () => {
    expect(applyPackageImports("#http", importer(), root)).toBe("undici");
    expect(applyPackageImports("#nothing", importer(), root)).toBe("#nothing");
    expect(applyPackageImports("./db/clubs", importer(), root)).toBe("./db/clubs");
  });
});
