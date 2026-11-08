import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "signals-"));
  await writeFile(join(root, "garage.component.ts"), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, "garage.component.ts"), relativePath: "garage.component.ts", language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "signals-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("a receiver that is the value of a signal field", () => {
  it("is typed by the signal's generic argument, annotation or injected class; a non-signal states nothing", async () => {
    const a = await analyze(`import { Component, input, signal, computed, inject, model, Signal } from '@angular/core';
@Component({ selector: 'app-garage', template: '' })
export class GarageComponent {
  garage = input.required<GarageService>();
  parked = signal<Car | null>(null);
  built = computed(() => inject(MechanicService));
  held: Signal<CarService> = computed(() => this.cars);
  count = signal<number>(0);
  plain = () => 1;
  open() {
    this.garage().open();
    this.parked()?.start();
    this.built().tune();
    this.held().wash();
    this.count().toFixed();
    this.plain().toFixed();
  }
}`);
    const calls = a.classes[0]!.methods.find((m) => m.name === "open")!.calls;
    const typed = (name: string) => calls.find((c) => c.name === name)?.receiverType;
    expect(typed("this.garage().open")).toBe("GarageService");
    expect(typed("this.parked()?.start")).toBe("Car");
    expect(typed("this.built().tune")).toBe("MechanicService");
    expect(typed("this.held().wash")).toBe("CarService");
    expect(typed("this.count().toFixed")).toBeUndefined();
    expect(typed("this.plain().toFixed")).toBeUndefined();
  });
});
