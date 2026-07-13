import { describe, it, expect } from "vitest";
import { conventionRoots, analyzeUnusedCode } from "./dead-code.js";
import type { FileAnalysis } from "../types/analysis.js";

describe("conventionRoots", () => {
  it("marks generated/vendored dirs by path convention (spsflow FPs)", () => {
    const roots = conventionRoots([
      "dsps-server/src/main/java/dk/innobeat/dsps/jooq/generated/sps/tables/Student.java",
      "dsps-web/LEGACY/vendor/laravel/framework/src/Foo.php",
      "web/node_modules/lodash/index.js",
      "api/third_party/grpc/client.py",
    ]);
    expect(roots).toContain("dsps-server/src/main/java/dk/innobeat/dsps/jooq/generated");
    expect(roots).toContain("dsps-web/LEGACY/vendor");
    expect(roots).toContain("web/node_modules");
    expect(roots).toContain("api/third_party");
  });

  it("marks plugins/lib dirs only under static-asset containers", () => {
    const roots = conventionRoots([
      "dsps-web/public/js/plugins/ckeditor/ckeditor.js",
      "site/wwwroot/lib/bootstrap/bootstrap.js",
      // authored code named plugins/lib — NOT vendored
      "src/extractors/plugins/csharp/index.ts",
      "dsps_app/lib/util/ApiConnection.dart",
    ]);
    expect(roots).toContain("dsps-web/public/js/plugins");
    expect(roots).toContain("site/wwwroot/lib");
    expect(roots).not.toContain("src/extractors/plugins");
    expect(roots).not.toContain("dsps_app/lib");
  });

  it("never marks a root from the file segment itself", () => {
    expect(conventionRoots(["src/vendor.ts", "src/generated.py"])).toHaveLength(0);
  });
});

describe("analyzeUnusedCode — convention merge", () => {
  const analysis = (filePath: string): FileAnalysis =>
    ({ filePath, exports: [], imports: [] }) as unknown as FileAnalysis;

  it("returns convention roots even with no barrels present", () => {
    const { generatedRoots } = analyzeUnusedCode(
      [analysis("app/jooq/generated/Tables.java"), analysis("app/src/Main.java")],
      {},
    );
    expect(generatedRoots).toEqual(["app/jooq/generated"]);
  });

  it("keeps only the shallowest root when nested", () => {
    const { generatedRoots } = analyzeUnusedCode(
      [
        analysis("web/node_modules/pkg/index.js"),
        analysis("web/node_modules/pkg/vendor/dep.js"),
      ],
      {},
    );
    expect(generatedRoots).toEqual(["web/node_modules"]);
  });
});
