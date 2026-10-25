import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjectConfig, matchesAnyGlob, resolveArchitectureOverrides, PROJECT_CONFIG_RELATIVE_PATH } from "./project-config.js";

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

describe("loadProjectConfig — architecture sections", () => {
  it("reads layers, exempt and generated", () => {
    write(
      JSON.stringify({
        layers: [{ layer: "data", patterns: ["/src/db/**"], description: "EF" }],
        exempt: ["tools/**"],
        generated: ["**/*.generated.ts"],
      }),
    );
    const r = loadProjectConfig(root);
    expect(r.warnings).toEqual([]);
    expect(r.config.layers).toEqual([{ layer: "data", patterns: ["/src/db/**"] }]);
    expect(r.config.exempt).toEqual(["tools/**"]);
    expect(r.config.generated).toEqual(["**/*.generated.ts"]);
  });

  it("drops layer rules with an unknown layer or no patterns, keeping the rest", () => {
    write(JSON.stringify({ layers: [{ layer: "domain", patterns: ["a/**"] }, { layer: "ui", patterns: [] }, { layer: "ui", patterns: ["b/**"] }] }));
    const r = loadProjectConfig(root);
    expect(r.config.layers).toEqual([{ layer: "ui", patterns: ["b/**"] }]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/layers\[0\]/);
    expect(r.warnings[1]).toMatch(/layers\[1\]/);
  });

  it("keeps the string entries of a mixed exempt list and warns once", () => {
    write(JSON.stringify({ exempt: ["tools/**", 3, ""] }));
    const r = loadProjectConfig(root);
    expect(r.config.exempt).toEqual(["tools/**"]);
    expect(r.warnings).toEqual([expect.stringMatching(/"exempt" must be an array of glob strings/)]);
  });
});

describe("resolveArchitectureOverrides / matchesAnyGlob", () => {
  it("normalizes backslashes and keeps the slash that anchors", () => {
    const o = resolveArchitectureOverrides({ layers: [{ layer: "data", patterns: ["/src\\db/**"] }], exempt: ["/tools/**"] });
    expect(o.layers[0]!.patterns).toEqual(["/src/db/**"]);
    expect(matchesAnyGlob("src/db/x/y.ts", o.layers[0]!.patterns)).toBe(true);
    expect(matchesAnyGlob("tools/a.ts", o.exempt)).toBe(true);
    expect(matchesAnyGlob("src/tools/a.ts", o.exempt)).toBe(false);
  });

  it("matches a slash-less pattern against the bare name only", () => {
    expect(matchesAnyGlob("gen/api/Player.generated.ts", ["*.generated.ts"])).toBe(true);
    expect(matchesAnyGlob("gen/api/Player.ts", ["*.generated.ts"])).toBe(false);
  });

  it("denies the bare-name fallback to an anchored pattern", () => {
    // `/dist` is the build directory at the project root. Stripping its slash
    // turned it into a slash-less pattern, which then matched anything named
    // `dist` at any depth — the same anchoring loss as the ignore file's.
    expect(matchesAnyGlob("dist", ["/dist"])).toBe(true);
    expect(matchesAnyGlob("src/dist", ["/dist"])).toBe(false);
    expect(matchesAnyGlob("src/dist", ["dist"])).toBe(true);
    expect(matchesAnyGlob("src/vendor/gen.ts", ["/vendor/**"])).toBe(false);
    expect(matchesAnyGlob("vendor/gen.ts", ["/vendor/**"])).toBe(true);
  });
});

describe("loadProjectConfig — element rules", () => {
  it("reads each, allowOnly and noCycles, and drops a rule mixing kinds or with a bad each", () => {
    write(JSON.stringify({
      rules: [
        { name: "features apart", each: "src/features/*/" },
        { name: "use shared only", each: "src/features/*", allowOnly: "src/shared/**", severity: "warn" },
        { name: "no cycles", from: "src/**", noCycles: true },
        { name: "two kinds", from: "a/**", to: "b/**", noCycles: true },
        { name: "deep each", each: "src/**" },
      ],
    }));
    const r = loadProjectConfig(root);
    expect(r.config.rules).toEqual([
      { name: "features apart", from: [], to: [], each: "src/features/*", severity: "error" },
      { name: "use shared only", from: [], to: [], each: "src/features/*", allowOnly: ["src/shared/**"], severity: "warn" },
      { name: "no cycles", from: ["src/**"], to: [], noCycles: true, severity: "error" },
    ]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/rules\[3\] \(two kinds\) takes one of "to", "allowOnly" and "noCycles"/),
      expect.stringMatching(/rules\[4\] \(deep each\) "each" must be a directory pattern/),
    ]);
  });
});

describe("loadProjectConfig — dependency rules", () => {
  it("reads rules, accepts a single glob for a side, and drops malformed ones", () => {
    write(JSON.stringify({
      rules: [
        { name: "billing ↛ payroll", from: "features/billing/**", to: ["features/payroll/**"], except: ["**/shared/**"] },
        { name: "domain is pure", from: ["Domain/**"], to: ["Infrastructure/**"], severity: "warn" },
        { name: "no target", from: ["a/**"] },
        { from: ["a/**"], to: ["b/**"] },
      ],
    }));
    const r = loadProjectConfig(root);
    expect(r.config.rules).toEqual([
      { name: "billing ↛ payroll", from: ["features/billing/**"], to: ["features/payroll/**"], except: ["**/shared/**"], severity: "error" },
      { name: "domain is pure", from: ["Domain/**"], to: ["Infrastructure/**"], severity: "warn" },
    ]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/rules\[2\] \(no target\) needs "from" and "to"/),
      expect.stringMatching(/rules\[3\] needs a "name"/),
    ]);
  });
});
