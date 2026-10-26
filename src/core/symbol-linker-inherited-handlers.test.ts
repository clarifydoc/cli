import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis } from "../types/analysis.js";

const method = (name: string, line: number) => ({ name, line, endLine: line + 2, params: [], calls: [], returnType: null, isAsync: false, isExported: true, decorators: [] });
const klass = (name: string, ext: string | null, methods: unknown[]) =>
  ({ name, kind: "class", extends: ext, implements: [], methods, properties: [], decorators: [], isExported: true, line: 1, endLine: 30 });
const file = (filePath: string, o: { classes?: unknown[]; imports?: unknown[]; interactiveElements?: unknown[] }): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: o.imports ?? [], exports: [], functions: [], classes: o.classes ?? [], routes: [], dataSources: [], interactiveElements: o.interactiveElements ?? [] }) as unknown as FileAnalysis;

describe("template handlers a component inherits (real-repo shape)", () => {
  // A transfer dialog's template calls `cancel()` and `confirm()`, which its base dialog declares; `close()` it declares itself.
  const base = file("web/dialogs/confirm-dialog.component.ts", { classes: [klass("ConfirmDialogComponent", null, [method("cancel", 10), method("confirm", 14)])] });
  const transfer = file("web/dialogs/transfer-dialog/transfer-dialog.component.ts", {
    imports: [{ source: "../confirm-dialog.component", specifiers: ["ConfirmDialogComponent"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    classes: [klass("TransferDialogComponent", "ConfirmDialogComponent", [method("close", 5)])],
    interactiveElements: [
      { element: "button", event: "click", handler: "cancel()", line: 3 },
      { element: "button", event: "click", handler: "confirm()", line: 7 },
      { element: "button", event: "click", handler: "close()", line: 9 },
      { element: "button", event: "click", handler: "cancel()", line: 12 },
    ],
  });

  it("links the click from the component's anchor to the base class's method", () => {
    const links = buildSymbolLinks([base, transfer]).filter((l) => l.sourceSymbol === "<component>");
    expect(links.map((l) => [l.callName, l.targetFile, l.targetSymbol, l.strategy])).toEqual([
      ["cancel", "web/dialogs/confirm-dialog.component.ts", "ConfirmDialogComponent.cancel", "inheritance"],
      ["confirm", "web/dialogs/confirm-dialog.component.ts", "ConfirmDialogComponent.confirm", "inheritance"],
    ]);
  });
});
