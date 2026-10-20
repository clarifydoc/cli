import { describe, it, expect } from "vitest";
import { extractSwiftUINavigation } from "./swiftui-navigation.js";
import { SwiftEntityExtractor } from "./entities.js";
import type { ClassInfo } from "../../../types/analysis.js";

describe("SwiftUI navigation", () => {
  it("reads links, destinations, sheets, covers, windows and tabs; a value link's closure is its label", () => {
    const routes = extractSwiftUINavigation(`import SwiftUI
struct A: View {
  var body: some View {
    NavigationStack {
      List {
        NavigationLink("Edit", destination: EditView(item: item))
        NavigationLink { DetailView(item: item) } label: { Text("Open") }
        NavigationLink(value: item) { ItemRow(item: item) }
      }
      .navigationDestination(for: Item.self) { item in ItemView(item: item) }
      .sheet(isPresented: $adding) { AddView() }
      .fullScreenCover(item: $selected) { selected in PlayerView(track: selected) }
    }
  }
}`.split("\n"));
    expect(routes.map((r) => `${r.path}${r.navigation ? " (navigation)" : ""}`)).toEqual([
      "EditView (navigation)", "DetailView (navigation)", "ItemView (navigation)", "AddView (navigation)", "PlayerView (navigation)",
    ]);
  });

  it("reads nothing in a file that does not import SwiftUI", () => {
    expect(extractSwiftUINavigation(`struct X { func f() { NavigationLink(destination: Y()) } }`.split("\n"))).toEqual([]);
  });
});

describe("SwiftData and Core Data models", () => {
  const cls = (name: string, line: number, endLine: number, ext: string | null = null): ClassInfo => ({ name, line, endLine, extends: ext, implements: [], decorators: [], methods: [], properties: [], isExported: true });

  it("keeps stored properties only and relates model-typed ones", () => {
    const src = `@Model
final class Item {
  var name: String
  @Attribute(.unique) var code: String
  var owner: User?
  @Relationship(deleteRule: .cascade) var tags: [Tag] = []
  @Transient var draft = false
  var title: String {
    name.uppercased()
  }
}`;
    const r = new SwiftEntityExtractor().extract({ analysis: { classes: [cls("Item", 2, 11)] } as never, lines: src.split("\n"), sourceText: src } as never);
    expect(r.entities[0]!.properties.map((p) => `${p.name}:${p.type}${p.isRequired ? "" : "?"}`)).toEqual(["name:String", "code:String", "owner:User??", "tags:[Tag]"]);
    expect(r.relations.map((x) => `${x.fromField} ${x.cardinality} ${x.toEntity} ${x.confidence}`)).toEqual(["owner many-to-one User INFERRED", "tags one-to-many Tag EXTRACTED"]);
  });

  it("reads Core Data's @NSManaged properties", () => {
    const src = `public class Note: NSManagedObject {
  @NSManaged public var body: String?
  @NSManaged public var folder: Folder?
  var cached = 0
}`;
    const r = new SwiftEntityExtractor().extract({ analysis: { classes: [cls("Note", 1, 5, "NSManagedObject")] } as never, lines: src.split("\n"), sourceText: src } as never);
    expect(r.entities[0]!.decorators).toContain("coredata");
    expect(r.entities[0]!.properties.map((p) => p.name)).toEqual(["body", "folder"]);
  });
});
