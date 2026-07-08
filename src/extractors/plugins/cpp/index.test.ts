import { describe, it, expect } from "vitest";
import { extractCppStringConstants, tagQmlElementClasses, cppSpec } from "./index.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import { resolveDataSourceStringConstants } from "../../../core/import-index.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

describe("extractCppStringConstants", () => {
  it("captures #define string macros and const QString assignments", () => {
    const consts = extractCppStringConstants(`
#define CUE_TABLE "cues"
#define PLAYLIST_TABLE "Playlists"
#define NOT_A_STRING 42
const QString kTrackTable = QStringLiteral("library");
static const char* kDirTable = "directories";
    `.split("\n"));
    expect(consts).toEqual({
      CUE_TABLE: "cues",
      PLAYLIST_TABLE: "Playlists",
      kTrackTable: "library",
      kDirTable: "directories",
    });
  });
});

describe("resolveDataSourceStringConstants", () => {
  const analysisWith = (over: Partial<FileAnalysis>): FileAnalysis => ({
    ...createEmptyAnalysis(over.filePath ?? "a.cpp", "cpp"),
    ...over,
  });

  it("resolves macro-valued targets/entities through another file's constants", () => {
    const header = analysisWith({
      filePath: "dao/cuedao.h",
      stringConstants: { CUE_TABLE: "cues" },
    });
    const impl = analysisWith({
      filePath: "dao/cuedao.cpp",
      dataSources: [
        { kind: "database", name: "DELETE FROM", target: "CUE_TABLE", entity: "CUE_TABLE", calls: [], line: 10 },
        { kind: "database", name: "SELECT", target: "library", entity: "library", calls: [], line: 20 },
      ],
    });
    resolveDataSourceStringConstants([header, impl]);
    expect(impl.dataSources[0]).toMatchObject({ target: "cues", entity: "cues" });
    expect(impl.dataSources[1]).toMatchObject({ target: "library", entity: "library" });
  });

  it("leaves names with conflicting definitions unresolved", () => {
    const a = analysisWith({ filePath: "a.h", stringConstants: { T: "one" } });
    const b = analysisWith({ filePath: "b.h", stringConstants: { T: "two" } });
    const impl = analysisWith({
      filePath: "c.cpp",
      dataSources: [{ kind: "database", name: "UPDATE", target: "T", entity: "T", calls: [], line: 1 }],
    });
    resolveDataSourceStringConstants([a, b, impl]);
    expect(impl.dataSources[0]!.target).toBe("T");
  });
});

describe("tagQmlElementClasses", () => {
  it("tags QML_NAMED_ELEMENT / QML_ELEMENT / QML_SINGLETON classes", () => {
    const src = `
class QmlBatteryProxy : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(Battery)
    QML_SINGLETON
  public:
    void doThing();
};
class QmlControlProxy : public QObject {
    QML_ELEMENT
};
class PlainClass {
    void nothing();
};
    `.split("\n");
    const classes = tagQmlElementClasses(src, extractClassesWithSpec(src, cppSpec));
    const byName = Object.fromEntries(classes.map((c) => [c.name, c.decorators]));
    expect(byName["QmlBatteryProxy"]).toContain("qml-element:Battery");
    expect(byName["QmlBatteryProxy"]).toContain("qml-singleton");
    expect(byName["QmlControlProxy"]).toContain("qml-element:QmlControlProxy");
    expect(byName["PlainClass"]).toEqual([]);
  });
});
