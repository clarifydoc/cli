import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";
import { purlOf, toCycloneDx } from "./sbom.js";
import { composerLockLicenses, packageLockLicenses } from "../extractors/plugins/shared/lockfiles.js";
import { loadReportSummary } from "../core/report-payload.js";

describe("purls", () => {
  it("writes each ecosystem's package-url", () => {
    expect(purlOf({ ecosystem: "npm", name: "@tanstack/react-query" }, "5.0.0")).toBe("pkg:npm/%40tanstack/react-query@5.0.0");
    expect(purlOf({ ecosystem: "maven", name: "org.springframework:spring-core" }, "6.1.0")).toBe("pkg:maven/org.springframework/spring-core@6.1.0");
    expect(purlOf({ ecosystem: "pypi", name: "Flask_SQLAlchemy" }, "3.1")).toBe("pkg:pypi/flask-sqlalchemy@3.1");
    expect(purlOf({ ecosystem: "go", name: "github.com/gin-gonic/gin" }, "v1.9.1")).toBe("pkg:golang/github.com/gin-gonic/gin@v1.9.1");
    expect(purlOf({ ecosystem: "composer", name: "laravel/framework" })).toBe("pkg:composer/laravel/framework");
    expect(purlOf({ ecosystem: "nimble", name: "jester" })).toBe("pkg:generic/jester");
  });
});

describe("lockfile licences", () => {
  it("reads npm and Composer locks", () => {
    expect(packageLockLicenses(JSON.stringify({ packages: { "": { license: "UNLICENSED" }, "node_modules/react": { license: "MIT" }, "node_modules/a/node_modules/b": { license: "ISC" } } }))).toEqual(new Map([["react", "MIT"]]));
    expect(composerLockLicenses(JSON.stringify({ packages: [{ name: "a/b", license: ["MIT"] }, { name: "c/d", license: ["GPL-2.0-only", "MIT"] }] }))).toEqual(
      new Map([["a/b", "MIT"], ["c/d", "(GPL-2.0-only OR MIT)"]]),
    );
  });
});

describe("transitive requirements", () => {
  it("are marked on their component", () => {
    const bom = toCycloneDx({ externalPackages: [
      { name: "github.com/example/pitlane", version: "v1.2.0", ecosystem: "go", scope: "prod", category: "other", declaredIn: "go.mod" },
      { name: "github.com/example/tyrewear", version: "v0.4.1", ecosystem: "go", scope: "prod", category: "other", declaredIn: "go.mod", transitive: true },
    ] } as never, "garage") as { components: Array<{ name: string; properties: Array<{ name: string; value: string }> }> };
    const props = (n: string) => bom.components.find((c) => c.name === n)!.properties.map((p) => `${p.name}=${p.value}`);
    expect(props("github.com/example/tyrewear")).toContain("clarifydoc:transitive=true");
    expect(props("github.com/example/pitlane")).not.toContain("clarifydoc:transitive=true");
  });
});

describe("packages of the repository itself", () => {
  it("are no components", () => {
    const bom = toCycloneDx({ externalPackages: [
      { name: "@league/tyres", version: "workspace:*", ecosystem: "npm", scope: "prod", category: "other", declaredIn: "apps/pitwall/package.json", local: "packages-tyres" },
      { name: "left-pad", version: "1.3.0", ecosystem: "npm", scope: "prod", category: "other", declaredIn: "apps/pitwall/package.json" },
    ] } as never, "garage") as { components: Array<{ name: string }> };
    expect(bom.components.map((c) => c.name)).toEqual(["left-pad"]);
  });
});

const fixture = resolve("test-output", "sample-react");
describe.skipIf(!existsSync(fixture))("the SBOM of a fixture", () => {
  it("is CycloneDX 1.5 with one component per declared package, a purl each, dev dependencies excluded", async () => {
    const s = await loadReportSummary(fixture);
    const bom = toCycloneDx(s as never, "sample-react") as { bomFormat: string; specVersion: string; serialNumber: string; components: Array<{ purl: string; scope: string; name: string }> };
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    const declared = (s.externalPackages ?? []).filter((p) => p.ecosystem !== "git");
    expect(bom.components).toHaveLength(declared.length);
    expect(new Set(bom.components.map((c) => c.purl)).size).toBe(bom.components.length);
    for (const c of bom.components) expect(c.purl).toMatch(/^pkg:[a-z]+\//);
    const dev = declared.find((p) => p.scope === "dev");
    if (dev) expect(bom.components.find((c) => c.name === dev.name)?.scope).toBe("excluded");
    expect(toCycloneDx(s as never, "sample-react")).toEqual(bom);
  });
});
