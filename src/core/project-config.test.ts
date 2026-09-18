import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjectConfig, PROJECT_CONFIG_RELATIVE_PATH } from "./project-config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarifydoc-config-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(body: string): void {
  mkdirSync(join(root, ".clarifydoc"), { recursive: true });
  writeFileSync(join(root, PROJECT_CONFIG_RELATIVE_PATH), body);
}

describe("loadProjectConfig", () => {
  it("returns empty defaults when no file exists", () => {
    expect(loadProjectConfig(root)).toEqual({ config: {}, path: null, warnings: [] });
  });

  it("reads the refactorPressure section", () => {
    write(JSON.stringify({ $comment: "x", refactorPressure: { ceilings: { loc: 1000 } } }));
    const r = loadProjectConfig(root);
    expect(r.path).toBe(join(root, PROJECT_CONFIG_RELATIVE_PATH));
    expect(r.config.refactorPressure).toEqual({ ceilings: { loc: 1000 } });
    expect(r.warnings).toEqual([]);
  });

  it("never throws on malformed JSON and says so", () => {
    write("{ not json");
    const r = loadProjectConfig(root);
    expect(r.config).toEqual({});
    expect(r.warnings[0]).toMatch(/not valid JSON/);
  });

  it("warns about unknown sections and wrongly typed ones", () => {
    write(JSON.stringify({ typo: 1, refactorPressure: [] }));
    const r = loadProjectConfig(root);
    expect(r.config.refactorPressure).toBeUndefined();
    expect(r.warnings).toEqual([
      expect.stringMatching(/unknown section "typo"/),
      expect.stringMatching(/"refactorPressure" must be an object/),
    ]);
  });
});
