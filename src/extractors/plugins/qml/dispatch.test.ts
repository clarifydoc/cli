import { describe, it, expect } from "vitest";
import { QmlCppBridgeResolver } from "./dispatch.js";
import { createEmptyAnalysis, type FileAnalysis, type FunctionInfo, type ClassInfo } from "../../../types/analysis.js";

const fn = (name: string, calls: { name: string; line: number }[]): FunctionInfo => ({
  name,
  params: [],
  returnType: null,
  isAsync: false,
  isExported: true,
  decorators: [],
  calls: calls.map((c) => ({ name: c.name, kind: "internal", target: null, line: c.line, column: 0 })),
  line: 1,
  endLine: 20,
});

const cls = (name: string, decorators: string[], methods: string[] = []): ClassInfo => ({
  name,
  extends: null,
  implements: [],
  decorators,
  methods: methods.map((m, i) => fn(m, []) && { ...fn(m, []), name: m, line: 10 + i }),
  properties: [],
  isExported: true,
  line: 5,
  endLine: 40,
});

describe("QmlCppBridgeResolver", () => {
  const cpp: FileAnalysis = {
    ...createEmptyAnalysis("src/qml/qmlplayermanagerproxy.h", "cpp"),
    classes: [cls("QmlPlayerManagerProxy", ["qml-element:PlayerManager", "qml-singleton"], ["getPlayer"])],
  };
  const cppControl: FileAnalysis = {
    ...createEmptyAnalysis("src/qml/qmlcontrolproxy.h", "cpp"),
    classes: [cls("QmlControlProxy", ["qml-element:ControlProxy"])],
  };
  const qml: FileAnalysis = {
    ...createEmptyAnalysis("res/qml/Deck.qml", "qml"),
    subComponents: [
      { name: "ControlProxy", importSource: null, props: [], line: 12 },
      { name: "Rectangle", importSource: null, props: [], line: 20 },
    ],
    functions: [fn("loadTrack", [{ name: "PlayerManager.getPlayer", line: 7 }])],
  };

  it("links component usages and singleton calls to the registered C++ classes", () => {
    const links = new QmlCppBridgeResolver().resolve([cpp, cppControl, qml]);
    expect(links).toHaveLength(2);

    const usage = links.find((l) => l.callName === "ControlProxy")!;
    expect(usage).toMatchObject({
      sourceFile: "res/qml/Deck.qml",
      sourceSymbol: "<component>",
      targetFile: "src/qml/qmlcontrolproxy.h",
      targetSymbol: "QmlControlProxy",
      confidence: "INFERRED",
    });

    const call = links.find((l) => l.callName === "PlayerManager.getPlayer")!;
    expect(call).toMatchObject({
      sourceSymbol: "loadTrack",
      targetFile: "src/qml/qmlplayermanagerproxy.h",
      targetSymbol: "QmlPlayerManagerProxy.getPlayer",
    });
  });

  it("returns nothing when no C++ class registers a QML element", () => {
    const plainCpp: FileAnalysis = {
      ...createEmptyAnalysis("src/engine.cpp", "cpp"),
      classes: [cls("Engine", [])],
    };
    expect(new QmlCppBridgeResolver().resolve([plainCpp, qml])).toEqual([]);
  });
});
