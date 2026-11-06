import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const read = (src: string) => extractWithRegex(src, "Sources/League/Club.swift", "swift");

describe("Swift extension heads and accessor return types (regex reading)", () => {
  it("drops an imported module from an extension head, keeps a nesting type", () => {
    const a = read(["import Foundation", "extension Foundation.Date {", "    func kickoff() -> String { \"x\" }", "}", "extension League.Table {", "    func rank() {}", "}"].join("\n"));
    expect(a.classes.map((c) => c.name)).toEqual(["Date", "League::Table"]);
  });

  it("gives a computed property's function its declared type", () => {
    const a = read(["struct Club {", "    var name: String", "    var title: String { name }", "    var squad: [Player] { get { [] } }", "    var level = 0 { didSet { reset() } }", "}"].join("\n"));
    const fns = Object.fromEntries(a.classes[0]!.methods.map((m) => [m.name, m.returnType ?? null]));
    expect(fns.title).toBe("String");
    expect(fns.squad).toBe("[Player]");
    expect(fns.level).toBeNull();
  });
});
