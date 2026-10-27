import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * An Angular template calling a method of an injected service (real-repo shape:
 * `(click)="downloadService.resumeQueue()"` beside `readonly downloadService = inject(DownloadService)`).
 * The handler used to be recorded as the bare `resumeQueue`, which the component does not declare, so
 * the click reached nothing. The template closes over the instance: the call resolves through the
 * field's type, as `this.transfers.pauseQueue()` in the class body does.
 */
describe("Angular template calls on a component field", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ng-fields-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web","dependencies":{"@angular/core":"17.0.0","@angular/common":"17.0.0"}}');
    await file(
      "src/app/transfer.service.ts",
      [
        'import { Injectable, inject } from "@angular/core";',
        'import { HttpClient } from "@angular/common/http";',
        '@Injectable({ providedIn: "root" })',
        "export class TransferService {",
        "  private http = inject(HttpClient);",
        "  pauseQueue() {",
        '    return this.http.post("/api/v2/transfers/pause", {});',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "src/app/toast.service.ts",
      'import { Injectable } from "@angular/core";\n@Injectable({ providedIn: "root" })\nexport class ToastService {\n  closeToast() {}\n}\n',
    );
    await file(
      "src/app/transfer-list.component.ts",
      [
        'import { Component, inject, signal } from "@angular/core";',
        'import { TransferService } from "./transfer.service";',
        'import { ToastService } from "./toast.service";',
        '@Component({ selector: "app-transfer-list", templateUrl: "./transfer-list.component.html" })',
        "export class TransferListComponent {",
        "  readonly transfers = inject(TransferService);",
        "  limit = signal(10);",
        "  constructor(private toasts: ToastService) {}",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "src/app/transfer-list.component.html",
      '<button (click)="transfers.pauseQueue()">Pause</button>\n<button (click)="toasts.closeToast()">Close</button>\n<button (click)="limit.set(20)">More</button>\n',
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the receiver and links the click through the field's type", async () => {
    const { loadReportSummary } = await import("./report-payload.js");
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const component = "src/app/transfer-list.component.ts";
    expect((summary.interactiveElements ?? []).filter((e) => e.filePath === component).map((e) => e.handler)).toEqual([
      "transfers.pauseQueue",
      "toasts.closeToast",
      "limit.set",
    ]);
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === component && l.sourceSymbol === "<component>");
    expect(links.map((l) => [l.callName, l.targetFile, l.targetSymbol]).sort()).toEqual([
      ["toasts.closeToast", "src/app/toast.service.ts", "ToastService.closeToast"],
      ["transfers.pauseQueue", "src/app/transfer.service.ts", "TransferService.pauseQueue"],
    ]);
  });
});
