import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { swiftSpec } from "./index.js";

const classes = (src: string) => swiftSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), swiftSpec);

describe("swift conformance", () => {
  it("splits a class's superclass from its protocols", () => {
    const [cls] = classes("final class CachingStore: BaseStore, Storing, Sendable {\n}");
    expect(cls.extends).toBe("BaseStore");
    expect(cls.implements).toEqual(["Storing", "Sendable"]);
  });

  it("treats every conformance of a struct as a protocol", () => {
    const [cls] = classes("struct Todo: Content, Codable {\n}");
    expect(cls.extends).toBeNull();
    expect(cls.implements).toEqual(["Content", "Codable"]);
  });

  it("covers actors and extensions", () => {
    const found = classes(["actor Counter {", "}", "extension Todo: Content {", "}"].join("\n"));
    expect(found.map((c) => [c.name, c.implements])).toEqual([
      ["Counter", []],
      ["Todo", ["Content"]],
    ]);
  });

  it("ignores a generic `where` clause", () => {
    const [cls] = classes("struct Box<T>: Storing where T: Codable {\n}");
    expect(cls.implements).toEqual(["Storing"]);
  });

  it("does not read a keyword out of prose in a comment", () => {
    // `/// … superclass AND protocol …` used to yield a class named AND.
    expect(classes("/// Only the first superclass AND protocol entry counts.").length).toBe(0);
  });
});

describe("swift members", () => {
  it("takes annotated stored properties with their modifiers", () => {
    const [cls] = classes(
      [
        "final class Store: BaseStore {",
        "    static let shared: Store = Store()",
        "    private var cache: [UUID: Todo] = [:]",
        "    let capacity: Int",
        "    func load() {",
        "        let local: Int = 1",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(cls.properties.map((p) => [p.name, p.type, p.isStatic, p.isReadonly])).toEqual([
      ["shared", "Store", true, true],
      ["cache", "[UUID: Todo]", false, false],
      ["capacity", "Int", false, true],
    ]);
  });

  it("extracts initialisers", () => {
    expect(functions("    init(capacity: Int) {\n    }").map((f) => f.name)).toEqual(["init"]);
    expect(functions("    required convenience init?(raw: String) {\n    }").map((f) => f.name)).toEqual(["init"]);
  });
});
