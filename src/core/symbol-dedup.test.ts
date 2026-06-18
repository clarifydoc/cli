import { describe, it, expect } from "vitest";
import { dropNameCollisionReferences } from "./symbol-dedup.js";
import type { FileAnalysis, SymbolLink } from "../types/analysis.js";

const fileWithMethod = (filePath: string, cls: string, method: string): FileAnalysis =>
  ({
    filePath,
    language: "csharp",
    functions: [],
    classes: [{ name: cls, methods: [{ name: method }] }],
  } as unknown as FileAnalysis);

const refLink = (sourceFile: string, targetFile: string, targetSymbol: string): SymbolLink =>
  ({
    sourceFile,
    sourceSymbol: "(reference)",
    sourceLine: 1,
    callName: targetSymbol,
    targetFile,
    targetSymbol,
    targetLine: 1,
    confidence: "INFERRED",
    resolvedBy: "lsp",
  } as unknown as SymbolLink);

describe("dropNameCollisionReferences", () => {
  const analyses = [
    fileWithMethod("Account.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
    fileWithMethod("Feature.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
    fileWithMethod("License.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
  ];

  it("drops cross-file references to a symbol the source file itself defines (name collision)", () => {
    const links = [
      refLink("Feature.Api/Controllers/InternalsController.cs", "Account.Api/Controllers/InternalsController.cs", "InternalsController.Ping"),
      refLink("License.Api/Controllers/InternalsController.cs", "Account.Api/Controllers/InternalsController.cs", "InternalsController.Ping"),
    ];
    expect(dropNameCollisionReferences(links, analyses)).toEqual([]);
  });

  it("keeps a genuine reference (source does NOT define the target symbol)", () => {
    const consumer = { filePath: "app/HomeController.cs", language: "csharp", functions: [], classes: [{ name: "HomeController", methods: [{ name: "Index" }] }] } as unknown as FileAnalysis;
    const link = refLink("app/HomeController.cs", "Account.Api/Controllers/InternalsController.cs", "InternalsController.Ping");
    expect(dropNameCollisionReferences([link], [...analyses, consumer])).toHaveLength(1);
  });

  it("leaves non-(reference) links and bare-leaf symbols untouched", () => {
    const call = { ...refLink("a.cs", "b.cs", "Foo.bar"), sourceSymbol: "X.run" } as SymbolLink;
    const bareLeaf = refLink("Feature.Api/Controllers/InternalsController.cs", "Account.Api/Controllers/InternalsController.cs", "Ping");
    expect(dropNameCollisionReferences([call, bareLeaf], analyses)).toHaveLength(2);
  });
});
