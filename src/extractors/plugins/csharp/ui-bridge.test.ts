import { describe, it, expect } from "vitest";
import { CsharpUiBridgeResolver } from "./ui-bridge.js";
import type { ClassInfo, FileAnalysis, FunctionInfo, InteractiveElementInfo, ScreenInfo } from "../../../types/analysis.js";

function fn(name: string, line: number): FunctionInfo {
  return { name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine: line + 5 };
}

function cls(name: string, methods: FunctionInfo[]): ClassInfo {
  return { name, extends: null, implements: [], decorators: [], methods, properties: [], isExported: true, line: 1, endLine: 100 };
}

function analysis(
  filePath: string,
  language: FileAnalysis["language"],
  over: Partial<Pick<FileAnalysis, "classes" | "interactiveElements" | "screens" | "functions">> = {},
): FileAnalysis {
  return {
    filePath,
    language,
    classes: over.classes ?? [],
    interactiveElements: over.interactiveElements ?? [],
    screens: over.screens ?? [],
    functions: over.functions ?? [],
  } as unknown as FileAnalysis;
}

function el(handler: string, line = 10): InteractiveElementInfo {
  return { element: "button", event: "Click", handler, line };
}

const resolver = new CsharpUiBridgeResolver();

describe("CsharpUiBridgeResolver — WinForms partials", () => {
  it("links Designer wiring to the handler in the other partial file", () => {
    const designer = analysis("app/FrmMain.Designer.cs", "csharp", {
      classes: [cls("FrmMain", [fn("InitializeComponent", 8)])],
      interactiveElements: [el("MnuOpenFile_Click", 25)],
    });
    const main = analysis("app/FrmMain.cs", "csharp", {
      classes: [cls("FrmMain", [fn("MnuOpenFile_Click", 120)])],
    });
    const links = resolver.resolve([designer, main]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceFile: "app/FrmMain.Designer.cs",
      sourceSymbol: "FrmMain.InitializeComponent",
      callName: "MnuOpenFile_Click",
      targetFile: "app/FrmMain.cs",
      targetSymbol: "FrmMain.MnuOpenFile_Click",
      targetLine: 120,
      confidence: "INFERRED",
    });
  });

  it("skips handlers declared in the same file", () => {
    const single = analysis("app/FrmSolo.cs", "csharp", {
      classes: [cls("FrmSolo", [fn("BtnGo_Click", 40)])],
      interactiveElements: [el("BtnGo_Click")],
    });
    // A second partial exists but the handler is local — no synthetic link.
    const other = analysis("app/FrmSolo.Designer.cs", "csharp", {
      classes: [cls("FrmSolo", [fn("InitializeComponent", 5), fn("BtnGo_Click", 90)])],
    });
    expect(resolver.resolve([single, other])).toHaveLength(0);
  });

  it("prefers the same-directory partial when class names collide across app versions", () => {
    const designer = analysis("v9/App/FrmMain.Designer.cs", "csharp", {
      classes: [cls("FrmMain", [fn("InitializeComponent", 8)])],
      interactiveElements: [el("MnuSave_Click")],
    });
    const v9 = analysis("v9/App/FrmMain.cs", "csharp", {
      classes: [cls("FrmMain", [fn("MnuSave_Click", 50)])],
    });
    const v10 = analysis("source/App/FrmMain.cs", "csharp", {
      classes: [cls("FrmMain", [fn("MnuSave_Click", 70)])],
    });
    const links = resolver.resolve([designer, v9, v10]);
    expect(links).toHaveLength(1);
    expect(links[0]!.targetFile).toBe("v9/App/FrmMain.cs");
  });
});

describe("CsharpUiBridgeResolver — Blazor code-behind", () => {
  it("links a .razor handler to the component's .razor.cs partial, not to its own @code methods", () => {
    const markup = analysis("Pages/Garage.razor", "blazor", {
      interactiveElements: [el("OnRepairClicked", 12), el("Refresh", 14)],
      functions: [fn("Refresh", 30)],
    });
    const codeBehind = analysis("Pages/Garage.razor.cs", "csharp", {
      classes: [cls("Garage", [fn("OnRepairClicked", 20), fn("Refresh", 40)])],
    });
    const elsewhere = analysis("Admin/Garage.razor.cs", "csharp", {
      classes: [cls("Garage", [fn("OnRepairClicked", 8)])],
    });
    const links = resolver.resolve([markup, elsewhere, codeBehind]);
    expect(links.map((l) => `${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "12 OnRepairClicked -> Pages/Garage.razor.cs::Garage.OnRepairClicked",
    ]);
  });
});

describe("CsharpUiBridgeResolver — XAML code-behind", () => {
  const screen: ScreenInfo = {
    name: "ColorPickerToolControl", formType: "PhControl", caption: null,
    dimensions: null, components: [], filePath: "Lib/ColorPickerToolControl.axaml",
    routePath: null, navigatesTo: [],
  };

  it("links axaml elements to the x:Class code-behind method", () => {
    const markup = analysis("Lib/ColorPickerToolControl.axaml", "xaml", {
      screens: [screen],
      interactiveElements: [el("ButtonCopy_Click", 121)],
    });
    const codeBehind = analysis("Lib/ColorPickerToolControl.axaml.cs", "csharp", {
      classes: [cls("ColorPickerToolControl", [fn("ButtonCopy_Click", 33)])],
    });
    const links = resolver.resolve([markup, codeBehind]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceFile: "Lib/ColorPickerToolControl.axaml",
      sourceSymbol: "<component>",
      callName: "ButtonCopy_Click",
      targetFile: "Lib/ColorPickerToolControl.axaml.cs",
      targetSymbol: "ColorPickerToolControl.ButtonCopy_Click",
      confidence: "INFERRED",
    });
  });

  it("returns nothing when no class declares the handler", () => {
    const markup = analysis("Lib/Foo.axaml", "xaml", {
      interactiveElements: [el("Missing_Click")],
    });
    const codeBehind = analysis("Lib/Foo.axaml.cs", "csharp", {
      classes: [cls("Foo", [fn("Other_Click", 5)])],
    });
    expect(resolver.resolve([markup, codeBehind])).toHaveLength(0);
  });
});

describe("CsharpUiBridgeResolver — MAUI command bindings", () => {
  it("joins `{Binding CheckoutCommand}` to the view model's [RelayCommand] method (x:DataType)", () => {
    const view = analysis("src/ClientApp/Views/GarageView.xaml", "xaml", {
      screens: [{ name: "GarageView", viewModel: "GarageViewModel" } as ScreenInfo],
      interactiveElements: [
        { element: "button", event: "command", handler: "CheckoutCommand", line: 88 },
        { element: "button", event: "command", handler: "Source", line: 90 },
        { element: "button", event: "command", handler: "MissingCommand", line: 92 },
      ],
    });
    const relay = (name: string, line: number) => ({ ...fn(name, line), decorators: ["RelayCommand"] });
    const vm = analysis("src/ClientApp/ViewModels/GarageViewModel.cs", "csharp", {
      classes: [cls("GarageViewModel", [relay("AddAsync", 53), relay("CheckoutAsync", 104), fn("Missing", 120)])],
    });
    const links = resolver.resolve([view, vm]);
    expect(links.map((l) => `${l.callName}@${l.sourceLine} -> ${l.targetSymbol}`)).toEqual(["CheckoutCommand@88 -> GarageViewModel.CheckoutAsync"]);
  });
});
