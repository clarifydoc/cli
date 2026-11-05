import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { applyScalaExtensions } from "./extensions.js";

const read = (path: string, src: string): FileAnalysis => {
  const a = extractWithRegex(src, path, "scala") as FileAnalysis;
  a.projectId = "root";
  applyScalaExtensions(a, src);
  return a;
};

const EXT = [
  "package league", // 1
  "case class Club(name: String)", // 2
  "case class Car(name: String)", // 3
  "extension (club: Club)", // 4
  "  def promote(): Unit =", // 5
  "    club.save()", // 6
  "  def relegate(): Unit = ()", // 7
  "extension [T](car: Car) { def tune(): Unit = () }", // 8
  "extension (car: Car) def wash(): Unit = ()", // 9
  "def promote(): Unit = ()", // 10
].join("\n");

describe("Scala 3 extension methods", () => {
  it("a def under an extension header takes the block's parameter as its receiver", () => {
    const a = read("league/Ext.scala", EXT);
    const recv = (n: string, line: number) => a.functions.find((f) => f.name === n && f.line === line)?.params.find((p) => p.isReceiver)?.type;
    expect(recv("promote", 5)).toBe("Club");
    expect(recv("relegate", 7)).toBe("Club");
    expect(recv("tune", 8)).toBe("Car");
    expect(recv("wash", 9)).toBe("Car");
    expect(recv("promote", 10)).toBeUndefined(); // a free def after the block is no extension
  });

  it("club.promote() resolves to the extension of Club, not a namesake on Car", () => {
    const user = "package league\nobject Use {\n  def run(club: Club, car: Car): Unit = {\n    club.promote()\n    car.promote()\n  }\n}\n";
    const analyses = [read("league/Ext.scala", EXT), read("league/Use.scala", user)];
    const links = buildSymbolLinks(analyses).filter((l) => l.callName.endsWith(".promote"));
    expect(links.map((l) => `${l.callName}@${l.sourceLine}->${l.targetFile}:${l.targetLine}`)).toEqual(["club.promote@4->league/Ext.scala:5"]);
  });
});
