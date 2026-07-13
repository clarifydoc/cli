import { describe, it, expect } from "vitest";
import { PascalUiBridgeResolver } from "./ui-bridge.js";
import { createEmptyAnalysis, type FileAnalysis, type ClassInfo, type FunctionInfo } from "../../../types/analysis.js";

function method(name: string, line: number): FunctionInfo {
  return { name, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line, endLine: line + 3 };
}

function cls(name: string, methods: FunctionInfo[], ext: string | null = "TForm"): ClassInfo {
  return { name, extends: ext, implements: [], decorators: [], methods, properties: [], isExported: true, line: 1, endLine: 100 };
}

function dfm(filePath: string, formClass: string, handlers: { event: string; handler: string; line: number }[]): FileAnalysis {
  const a = createEmptyAnalysis(filePath, "dfm");
  a.classes = [cls(formClass, [], null)];
  a.interactiveElements = handlers.map((h) => ({ element: "button" as const, event: h.event, handler: h.handler, line: h.line }));
  return a;
}

function pas(filePath: string, classes: ClassInfo[]): FileAnalysis {
  const a = createEmptyAnalysis(filePath, "pascal");
  a.classes = classes;
  return a;
}

const resolver = new PascalUiBridgeResolver();

describe("PascalUiBridgeResolver", () => {
  it("links a DFM event to the companion unit's form method", () => {
    const links = resolver.resolve([
      dfm("app/UMainForm.dfm", "TMainForm", [{ event: "OnClick", handler: "btnCloseClick", line: 36 }]),
      pas("app/UMainForm.pas", [cls("TMainForm", [method("btnCloseClick", 88), method("FormCreate", 60)])]),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceFile: "app/UMainForm.dfm",
      sourceSymbol: "<component>",
      callName: "btnCloseClick",
      targetFile: "app/UMainForm.pas",
      targetSymbol: "TMainForm.btnCloseClick",
      targetLine: 88,
      confidence: "INFERRED",
    });
  });

  it("prefers the companion unit over a same-named class elsewhere", () => {
    const links = resolver.resolve([
      dfm("v2/UMain.dfm", "TMainForm", [{ event: "OnClick", handler: "Go", line: 5 }]),
      pas("v1/UMain.pas", [cls("TMainForm", [method("Go", 10)])]),
      pas("v2/UMain.pas", [cls("TMainForm", [method("Go", 20)])]),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.targetFile).toBe("v2/UMain.pas");
    expect(links[0]!.targetLine).toBe(20);
  });

  it("climbs visual form inheritance to a base form's handler", () => {
    const links = resolver.resolve([
      dfm("app/UChild.dfm", "TChildForm", [{ event: "OnClick", handler: "HandleSave", line: 9 }]),
      pas("app/UChild.pas", [cls("TChildForm", [method("ChildOnly", 5)], "TBaseForm")]),
      pas("app/UBase.pas", [cls("TBaseForm", [method("HandleSave", 42)])]),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.targetSymbol).toBe("TBaseForm.HandleSave");
    expect(links[0]!.targetFile).toBe("app/UBase.pas");
  });

  it("matches handler names case-insensitively (Pascal is)", () => {
    const links = resolver.resolve([
      dfm("a/F.dfm", "TF", [{ event: "OnClick", handler: "BtnGoClick", line: 2 }]),
      pas("a/F.pas", [cls("TF", [method("btngoclick", 7)])]),
    ]);
    expect(links).toHaveLength(1);
  });

  it("emits nothing when the handler exists nowhere", () => {
    const links = resolver.resolve([
      dfm("a/F.dfm", "TF", [{ event: "OnClick", handler: "Missing", line: 2 }]),
      pas("a/F.pas", [cls("TF", [method("Other", 7)])]),
    ]);
    expect(links).toHaveLength(0);
  });

  it("treats a Lazarus .lfm companion like a .dfm one", () => {
    const links = resolver.resolve([
      dfm("v2/Unit1.lfm", "TForm1", [{ event: "OnClick", handler: "Go", line: 5 }]),
      pas("v1/Unit1.pas", [cls("TForm1", [method("Go", 10)])]),
      pas("v2/Unit1.pas", [cls("TForm1", [method("Go", 20)])]),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.targetFile).toBe("v2/Unit1.pas");
  });
});
