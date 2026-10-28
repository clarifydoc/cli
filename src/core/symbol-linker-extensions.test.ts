import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, ParamInfo, PropertyInfo } from "../types/analysis.js";

/**
 * Extension functions as receivers: the body of `fun Garage.total() = bay.count()`
 * sees its receiver's members, a chain goes on through an extension's declared
 * return type, and a static member an extension adds is reached through the
 * class (`Car.Build()`). Hand-built analyses, as the plugins emit them.
 */

const call = (name: string, line = 10): CallInfo => ({ name, kind: "internal", target: null, line });

const fn = (name: string, line: number, calls: CallInfo[] = [], params: ParamInfo[] = [], returnType: string | null = null): FunctionInfo =>
  ({ name, line, endLine: line, params, calls, returnType, isAsync: false, isExported: true, decorators: [] });

const receiver = (type: string, name = "this"): ParamInfo => ({ name, type, defaultValue: null, isReceiver: true });

const prop = (name: string, type: string): PropertyInfo =>
  ({ name, type, visibility: "public", isStatic: false, isReadonly: true });

const cls = (name: string, o: Partial<ClassInfo> = {}): ClassInfo =>
  ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 20, ...o });

const file = (filePath: string, language: string, classes: ClassInfo[], functions: FunctionInfo[] = []): FileAnalysis =>
  ({ filePath, projectId: "root", language, functions, classes, imports: [], exports: [], routes: [], dataSources: [] } as unknown as FileAnalysis);

const edges = (analyses: FileAnalysis[], from: string) =>
  buildSymbolLinks(analyses).filter((l) => l.sourceSymbol === from && l.relation !== "reference")
    .map((l) => `${l.callName} -> ${l.targetSymbol} [${l.strategy}]`).sort();

describe("extension receivers", () => {
  const kotlin = (): FileAnalysis[] => [
    file("league/Bay.kt", "kotlin", [cls("Bay", { methods: [fn("count", 3)] })]),
    file("league/Garage.kt", "kotlin", [cls("Garage", { properties: [prop("bay", "Bay"), prop("inventory", "List<String>")] })]),
    file("league/GarageExt.kt", "kotlin", [cls("Report", { line: 3, endLine: 3, methods: [fn("print", 3)] })], [
      fn("total", 5, [call("bay.count", 5)], [receiver("Garage")], "Int"),
      fn("depth", 6, [call("this.bay.count", 6)], [receiver("Garage")], "Int"),
      fn("inventory", 7, [], [receiver("Garage")], "Report"),
    ]),
    file("league/Mechanic.kt", "kotlin", [cls("Mechanic", {
      methods: [fn("service", 10, [call("g.inventory().print", 11), call("g.inventory", 11)], [{ name: "g", type: "Garage", defaultValue: null }])],
    })]),
  ];

  it("an extension body reads its receiver's fields, bare and through `this.`", () => {
    expect(edges(kotlin(), "total")).toEqual(["bay.count -> Bay.count [injection]"]);
    expect(edges(kotlin(), "depth")).toEqual(["this.bay.count -> Bay.count [injection]"]);
  });

  it("a chain goes on through what an extension function returns", () => {
    expect(edges(kotlin(), "Mechanic.service")).toEqual([
      "g.inventory -> inventory [injection]",
      "g.inventory().print -> Report.print [injection]",
    ]);
  });

  it("a static member an extension block adds is reached through its class", () => {
    const analyses = [
      file("Car.cs", "csharp", [cls("Car", { properties: [prop("Speed", "int")] })]),
      file("CarExtensions.cs", "csharp", [cls("CarExtensions", { methods: [fn("Build", 4, [], [receiver("Car", "car")], "Car"), fn("Honk", 5, [], [receiver("Car", "car")])] })]),
      file("Mechanic.cs", "csharp", [cls("Mechanic", {
        methods: [fn("Service", 10, [call("Car.Build", 11), call("car.Honk", 12)], [{ name: "car", type: "Car", defaultValue: null }])],
      })]),
    ];
    expect(edges(analyses, "Mechanic.Service")).toEqual([
      "Car.Build -> CarExtensions.Build [class-name]",
      "car.Honk -> CarExtensions.Honk [injection]",
    ]);
  });
});
