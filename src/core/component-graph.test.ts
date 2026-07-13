import { describe, it, expect } from "vitest";
import { buildComponentGraph } from "./analyzer.js";
import { createEmptyAnalysis, type FileAnalysis, type ImportInfo, type ExportInfo } from "../types/analysis.js";

function file(
  filePath: string,
  opts: { imports?: Partial<ImportInfo>[]; exports?: string[]; language?: FileAnalysis["language"] } = {},
): FileAnalysis {
  const a = createEmptyAnalysis(filePath, opts.language ?? "pascal");
  a.imports = (opts.imports ?? []).map((i) => ({
    source: i.source ?? "?",
    specifiers: i.specifiers ?? [i.source ?? "?"],
    isDefault: false,
    isNamespace: true,
    isType: false,
    line: 1,
    ...i,
  })) as ImportInfo[];
  a.exports = (opts.exports ?? []).map(
    (name): ExportInfo => ({ name, kind: "class", line: 1 }),
  );
  return a;
}

describe("buildComponentGraph — same-name disambiguation", () => {
  it("resolves a bare unit import to the SAME project's file, not an insertion accident", () => {
    const graph = buildComponentGraph([
      file("proj-a/Unit1.pas", { exports: ["TForm1"] }),
      file("proj-b/Unit1.pas", { exports: ["TForm1"] }),
      file("proj-b/main.dpr", { imports: [{ source: "Unit1", specifiers: ["Unit1"] }] }),
      file("proj-a/app.dpr", { imports: [{ source: "Unit1", specifiers: ["Unit1"] }] }),
    ]);
    expect(graph["proj-b/main.dpr"]).toEqual(["proj-b/Unit1.pas"]);
    expect(graph["proj-a/app.dpr"]).toEqual(["proj-a/Unit1.pas"]);
  });

  it("resolves exported names to the closest declaring file (when the symbol is used)", () => {
    const consumer = file("app-two/Consumer.pas", {
      imports: [{ source: "Whatever", specifiers: ["TUserService"] }],
    });
    // Namespace imports resolve by export name only when the file USES the
    // symbol — otherwise a TLB unit exporting thousands of names collects
    // an edge from every unit in the repo.
    consumer.typeReferences = [{ typeName: "TUserService", line: 5, context: "type" } as never];
    const graph = buildComponentGraph([
      file("app-one/UserService.pas", { exports: ["TUserService"] }),
      file("app-two/UserService.pas", { exports: ["TUserService"] }),
      consumer,
    ]);
    expect(graph["app-two/Consumer.pas"]).toEqual(["app-two/UserService.pas"]);
  });

  it("gates namespace-import symbol matches on actual use", () => {
    const graph = buildComponentGraph([
      file("tlbs/Word_97.pas", { exports: ["Font", "Options", "Selection"] }),
      file("app/main.dpr", { imports: [{ source: "Font", specifiers: ["Font"] }] }),
    ]);
    expect(graph["app/main.dpr"]).toBeUndefined();
  });

  it("matches basenames case-insensitively (uses about → ABOUT.PAS)", () => {
    const graph = buildComponentGraph([
      file("app/ABOUT.PAS", { exports: [] }),
      file("app/main.dpr", { imports: [{ source: "about", specifiers: ["about"] }] }),
    ]);
    expect(graph["app/main.dpr"]).toEqual(["app/ABOUT.PAS"]);
  });

  it("never resolves an import to the importing file itself, even when self is closest", () => {
    const graph = buildComponentGraph([
      file("pkg-a/UserService.java", {
        language: "java",
        exports: ["UserService"],
        imports: [{ source: "otherpkg.UserService", specifiers: ["UserService"] }],
      }),
      file("pkg-b/UserService.java", { language: "java", exports: ["UserService"] }),
    ]);
    expect(graph["pkg-a/UserService.java"]).toEqual(["pkg-b/UserService.java"]);
  });
});

describe("buildComponentGraph — language-family fence", () => {
  it("never resolves a relative import across language families (spsflow FP: web.php → *.kt)", () => {
    const graph = buildComponentGraph([
      file("dsps-web/LEGACY/routes/web.php", {
        language: "php",
        imports: [{ source: "./ChatService", specifiers: [] }],
      }),
      file("dsps-server/functions/chat/ChatService.kt", { language: "kotlin", exports: ["ChatService"] }),
    ]);
    expect(graph["dsps-web/LEGACY/routes/web.php"]).toBeUndefined();
  });

  it("fences sub-component references the same way (kt → dart)", () => {
    const kt = file("server/mobileapp/view/AppController.kt", { language: "kotlin" });
    kt.subComponents = [{ name: "NewChatPage", importSource: "NewChatPage", line: 1 } as never];
    const graph = buildComponentGraph([
      kt,
      file("dsps_app/lib/widgets/chatPage/NewChatPage.dart", { language: "dart" }),
    ]);
    expect(graph["server/mobileapp/view/AppController.kt"]).toBeUndefined();
  });

  it("keeps unknown-family sources eligible (an .html page script-links .js)", () => {
    const page = file("site/index.html", { language: "html" });
    page.subComponents = [{ name: "app", importSource: "js/app", line: 1 } as never];
    const graph = buildComponentGraph([page, file("site/js/app.js", { language: "javascript" })]);
    expect(graph["site/index.html"]).toEqual(["site/js/app.js"]);
  });
});

describe("buildComponentGraph — project scope", () => {
  it("same-project export wins over a textually-closer sibling project", () => {
    const consumer = file("sol/apps/mail/deep/nested/Consumer.pas", {
      imports: [{ source: "Progress", specifiers: ["Progress"] }],
    });
    consumer.projectId = "sol/apps/mail";
    const near = file("sol/apps/mail-common/Progress.pas", { exports: [] });
    near.projectId = "sol/apps/mail-common";
    const own = file("sol/apps/mail/Progress.pas", { exports: [] });
    own.projectId = "sol/apps/mail";
    const graph = buildComponentGraph([consumer, near, own]);
    expect(graph["sol/apps/mail/deep/nested/Consumer.pas"]).toEqual(["sol/apps/mail/Progress.pas"]);
  });
});
