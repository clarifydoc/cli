import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers external-module prefixes
import { isExternalPackage, buildFilePathMap, resolveTarget } from "./link-scoring.js";

describe("isExternalPackage", () => {
  it("matches delimiter-suffixed prefixes literally (java., std::, Illuminate\\)", () => {
    expect(isExternalPackage("java.util.List")).toBe(true);
    expect(isExternalPackage("javax.servlet.http.HttpServlet")).toBe(true);
    expect(isExternalPackage("std::collections::HashMap")).toBe(true);
    expect(isExternalPackage("Illuminate\\Support\\Str")).toBe(true);
    expect(isExternalPackage("net/http")).toBe(true);
    expect(isExternalPackage("Microsoft.EntityFrameworkCore")).toBe(true);
  });

  it("matches Delphi unit-scope namespaces and classic RTL units", () => {
    expect(isExternalPackage("System.SysUtils")).toBe(true);
    expect(isExternalPackage("FMX.Forms")).toBe(true);
    expect(isExternalPackage("Vcl.Controls")).toBe(true);
    expect(isExternalPackage("FireDAC.Comp.Client")).toBe(true);
    expect(isExternalPackage("Windows")).toBe(true);
    expect(isExternalPackage("wintypes")).toBe(true);
    expect(isExternalPackage("IdHTTP")).toBe(true);
  });

  it("keeps bare-root semantics: a root matches itself and dotted/slashed children only", () => {
    expect(isExternalPackage("System")).toBe(true);
    // A project unit that merely STARTS with a root name is not external.
    expect(isExternalPackage("SystemHelpers")).toBe(false);
    expect(isExternalPackage("FormsBuilder")).toBe(false);
    expect(isExternalPackage("UserService")).toBe(false);
    expect(isExternalPackage("UMainForm")).toBe(false);
  });
});

describe("resolveTarget — bare-name proximity", () => {
  const analyses = [
    { filePath: "calmira/SRC/DESK.PAS" },
    { filePath: "calmira/SRC/PROGRESS.PAS" },
    { filePath: "lzw/lzw_compress/Progress.pas" },
    { filePath: "proj-a/Unit1.pas" },
    { filePath: "proj-b/Unit1.pas" },
    { filePath: "proj-b/main.dpr" },
  ] as any[];
  const map = buildFilePathMap(analyses);

  it("picks the same-project file over another project's same-named unit", () => {
    expect(resolveTarget("Progress", "calmira/SRC/DESK.PAS", map)).toBe("calmira/SRC/PROGRESS.PAS");
    expect(resolveTarget("Progress", "lzw/lzw_compress/other.pas", map)).toBe("lzw/lzw_compress/Progress.pas");
  });

  it("matches basenames case-insensitively (Pascal is)", () => {
    expect(resolveTarget("progress", "calmira/SRC/DESK.PAS", map)).toBe("calmira/SRC/PROGRESS.PAS");
  });

  it("disambiguates IDE-default names per project", () => {
    expect(resolveTarget("Unit1", "proj-b/main.dpr", map)).toBe("proj-b/Unit1.pas");
    expect(resolveTarget("Unit1", "proj-a/app.dpr", map)).toBe("proj-a/Unit1.pas");
  });
});

describe("resolveTarget — project scope beats path affinity", () => {
  it("prefers the importer's own sub-project even when another candidate is textually closer", () => {
    const analyses = [
      { filePath: "solution/apps/mailer/main.dpr", projectId: "solution/apps/mailer" },
      { filePath: "solution/apps/mail-common/Progress.pas", projectId: "solution/apps/mail-common" },
      { filePath: "solution/apps/mailer/lib/Progress.pas", projectId: "solution/apps/mailer" },
    ] as any[];
    const map = buildFilePathMap(analyses);
    expect(resolveTarget("Progress", "solution/apps/mailer/main.dpr", map)).toBe(
      "solution/apps/mailer/lib/Progress.pas",
    );
  });
});

describe("resolveTarget — language-family fence", () => {
  it("never resolves a Pascal uses-import to a doc-stub .js of the same name", () => {
    const analyses = [
      { filePath: "app/ServerModule.pas", projectId: "app" },
      { filePath: "docs/toc/u_urlOpen.js", projectId: "root" },
    ] as any[];
    const map = buildFilePathMap(analyses);
    expect(resolveTarget("u_urlOpen", "app/ServerModule.pas", map)).toBeNull();
  });

  it("still resolves within the family across extensions (js importer → ts file)", () => {
    const analyses = [
      { filePath: "web/src/services/userService.ts", projectId: "web" },
      { filePath: "web/src/page.js", projectId: "web" },
    ] as any[];
    const map = buildFilePathMap(analyses);
    expect(resolveTarget("userService", "web/src/page.js", map)).toBe("web/src/services/userService.ts");
  });
});
