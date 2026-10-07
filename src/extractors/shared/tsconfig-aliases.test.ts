import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyAliases, clearTsconfigAliasCache, loadTsconfigAliasesForDir } from "./tsconfig-aliases.js";

describe("tsconfig aliases", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-tsconfig-"));
    await mkdir(join(root, "src-ui/src/environments"), { recursive: true });
    await mkdir(join(root, "src-ui/src/app"), { recursive: true });
    await writeFile(
      join(root, "src-ui/tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "./", paths: { "@app/*": ["src/app/*"] } } }),
    );
    await writeFile(join(root, "src-ui/src/environments/environment.ts"), "export const environment = {};");
    clearTsconfigAliasCache();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a bare import under baseUrl when the file is there (paperless)", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("src/environments/environment", aliases, root)).toBe("src-ui/src/environments/environment");
  });

  it("leaves a package import alone even under baseUrl", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("rxjs/operators", aliases, root)).toBe("rxjs/operators");
    expect(applyAliases("@angular/core", aliases, root)).toBe("@angular/core");
  });

  it("still applies paths aliases first", () => {
    const aliases = loadTsconfigAliasesForDir(join(root, "src-ui/src/app"));
    expect(applyAliases("@app/services/x", aliases, root)).toBe("src-ui/src/app/services/x");
  });
});
