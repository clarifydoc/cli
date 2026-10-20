import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildSymbolLinks } from "../core/symbol-linker.js";
import { enhanceWithLsp, type DefinitionClient, type DefinitionSource } from "./lsp-enhancer.js";
import type { FileAnalysis } from "../types/analysis.js";

/**
 * Phase C: where dependency injection would not choose among an interface's
 * implementations, the language server is asked where the member is
 * implemented, and the answer kept as ground truth — not as a link.
 */
const method = (name: string, line: number, calls: unknown[] = []) => ({ name, line, endLine: line + 3, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [] });
const cls = (name: string, kind: "class" | "interface", methods: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name, kind, extends: null, implements: [], methods, properties: [], decorators: [], isExported: true, line: 1, endLine: 30, ...extra });
const file = (filePath: string, classes: unknown[]) =>
  ({ filePath, projectId: "root", language: "csharp", functions: [], classes, imports: [], exports: [], routes: [], dataSources: [] }) as unknown as FileAnalysis;

describe("LSP implementations at DI refusals", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-impl-"));
    await mkdir(join(dir, "App"), { recursive: true });
    await writeFile(join(dir, "App", "OrderService.cs"), `${"\n".repeat(9)}        _notifier.Send(order);\n`);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("asks where the interface member the call stayed on is implemented, and records the answer without linking it", async () => {
    const analyses = [
      file("Domain/INotifier.cs", [cls("INotifier", "interface", [method("Send", 3)])]),
      file("Infra/MailNotifier.cs", [cls("MailNotifier", "class", [method("Send", 7)], { implements: ["INotifier"] })]),
      file("Infra/SmsNotifier.cs", [cls("SmsNotifier", "class", [method("Send", 9)], { implements: ["INotifier"] })]),
      file("App/OrderService.cs", [cls("OrderService", "class", [method("Place", 5, [{ name: "_notifier.Send", kind: "internal", target: null, line: 10 }])], {
        properties: [{ name: "_notifier", type: "INotifier", visibility: "private", isStatic: false, isReadonly: true }],
      })]),
    ];
    const links = buildSymbolLinks(analyses);
    expect(links.find((l) => l.sourceFile === "App/OrderService.cs" && l.relation !== "reference")).toMatchObject({ targetSymbol: "INotifier.Send", strategy: "injection" });

    const asked: Array<[string, number, number]> = [];
    const client: DefinitionClient = {
      getDefinition: async () => [],
      getReferences: async () => [],
      supportsReferences: false,
      supportsImplementation: true,
      getImplementation: async (f, line, col) => {
        asked.push([f, line, col]);
        return [{ uri: "Infra/MailNotifier.cs", line: 6, character: 4 }, { uri: "Infra/SmsNotifier.cs", line: 8, character: 4 }];
      },
    };
    const source: DefinitionSource = { kind: "fake", initialize: async () => ["fake-csharp"], clientFor: () => client, shutdown: async () => {} };
    const r = await enhanceWithLsp({ projectRoot: dir, analyses, existingLinks: links, files: [], verbose: false, source });
    // At the method's own token, 0-based line.
    expect(asked).toEqual([["App/OrderService.cs", 9, 18]]);
    expect(r.implementationRecords).toEqual([{
      sourceFile: "App/OrderService.cs", sourceSymbol: "OrderService.Place", line: 10, column: 18, callName: "_notifier.Send",
      language: "csharp", interfaceSymbol: "INotifier.Send",
      implementations: [{ file: "Infra/MailNotifier.cs", line: 7 }, { file: "Infra/SmsNotifier.cs", line: 9 }],
    }]);
    // Recorded, not applied: the call still stays on the interface.
    expect(r.enhancedLinks.filter((l) => l.sourceFile === "App/OrderService.cs" && l.relation !== "reference").map((l) => l.targetSymbol)).toEqual(["INotifier.Send"]);
  });
});
