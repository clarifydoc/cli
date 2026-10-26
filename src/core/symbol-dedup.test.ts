import { describe, it, expect } from "vitest";
import { dedupSymbolLinks, dedupSymbolLinksAppend, dropNameCollisionReferences } from "./symbol-dedup.js";
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
    fileWithMethod("Club.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
    fileWithMethod("Feature.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
    fileWithMethod("License.Api/Controllers/InternalsController.cs", "InternalsController", "Ping"),
  ];

  it("drops cross-file references to a symbol the source file itself defines (name collision)", () => {
    const links = [
      refLink("Feature.Api/Controllers/InternalsController.cs", "Club.Api/Controllers/InternalsController.cs", "InternalsController.Ping"),
      refLink("License.Api/Controllers/InternalsController.cs", "Club.Api/Controllers/InternalsController.cs", "InternalsController.Ping"),
    ];
    expect(dropNameCollisionReferences(links, analyses)).toEqual([]);
  });

  it("keeps a genuine reference (source does NOT define the target symbol)", () => {
    const consumer = { filePath: "app/HomeController.cs", language: "csharp", functions: [], classes: [{ name: "HomeController", methods: [{ name: "Index" }] }] } as unknown as FileAnalysis;
    const link = refLink("app/HomeController.cs", "Club.Api/Controllers/InternalsController.cs", "InternalsController.Ping");
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
    const bareLeaf = refLink("Feature.Api/Controllers/InternalsController.cs", "Club.Api/Controllers/InternalsController.cs", "Ping");
    expect(dropNameCollisionReferences([call, bareLeaf], analyses)).toHaveLength(2);
  });
});

describe("dedupSymbolLinksAppend", () => {
  const l = (src: string, tgt: string, callName: string, line: number, confidence: SymbolLink["confidence"]): SymbolLink =>
    ({ sourceFile: "a.ts", sourceSymbol: src, sourceLine: line, callName, targetFile: "b.ts", targetSymbol: tgt, targetLine: 1, confidence }) as SymbolLink;
  it("gives what deduping the whole concatenation gives, reusing the earlier keys", () => {
    const first = [l("park", "Garage.open", "open", 5, "INFERRED"), l("park", "Garage.open", "open", 3, "INFERRED"), l("drive", "Car.start", "start", 9, "EXTRACTED")];
    const extra = [l("park", "Garage.open", "Open", 4, "EXTRACTED"), l("tow", "Car.start", "start", 2, "AMBIGUOUS"), l("drive", "Car.start", "start", 1, "EXTRACTED")];
    const deduped = dedupSymbolLinks(first);
    expect(dedupSymbolLinksAppend(deduped, extra)).toEqual(dedupSymbolLinks([...deduped, ...extra]));
    // An array grown since (or never deduped) falls back to the full pass.
    const grown = [...deduped, l("x", "y", "z", 1, "EXTRACTED")];
    expect(dedupSymbolLinksAppend(grown, extra)).toEqual(dedupSymbolLinks([...grown, ...extra]));
  });
});
