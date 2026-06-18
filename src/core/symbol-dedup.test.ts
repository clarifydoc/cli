import { describe, it, expect } from "vitest";
import { dropNameCollisionReferences } from "./symbol-dedup.js";
import type { FileAnalysis, SymbolLink } from "../types/analysis.js";

const fileWithMethod = (filePath: string, cls: string, method: string, ext?: string): FileAnalysis =>
  ({
    filePath,
    language: "csharp",
    functions: [],
    classes: [{ name: cls, methods: [{ name: method }], extends: ext ?? null }],
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

  it("drops base→derived virtual-dispatch references (base does not depend on its subclasses)", () => {
    const brokers = [
      fileWithMethod("Shared/RabbitMQ/BaseConsumerBroker.cs", "BaseConsumerBroker", "HandleMessage"),
      fileWithMethod("License/Services/RoleConsumerBroker.cs", "RoleConsumerBroker", "HandleMessage", "BaseConsumerBroker"),
      fileWithMethod("Feature/Services/RoleConsumerBroker.cs", "RoleConsumerBroker", "HandleMessage", "BaseConsumerBroker"),
    ];
    // LSP reports the base's virtual call as a reference to each subclass override.
    const links = [
      refLink("Shared/RabbitMQ/BaseConsumerBroker.cs", "License/Services/RoleConsumerBroker.cs", "RoleConsumerBroker.HandleMessage"),
      refLink("Shared/RabbitMQ/BaseConsumerBroker.cs", "Feature/Services/RoleConsumerBroker.cs", "RoleConsumerBroker.HandleMessage"),
    ];
    expect(dropNameCollisionReferences(links, brokers)).toEqual([]);
  });

  it("leaves non-(reference) links and bare-leaf symbols untouched", () => {
    const call = { ...refLink("a.cs", "b.cs", "Foo.bar"), sourceSymbol: "X.run" } as SymbolLink;
    const bareLeaf = refLink("Feature.Api/Controllers/InternalsController.cs", "Account.Api/Controllers/InternalsController.cs", "Ping");
    expect(dropNameCollisionReferences([call, bareLeaf], analyses)).toHaveLength(2);
  });
});
