import { describe, expect, it } from "vitest";
import { extractCoreDataEntities, extractCoreDataRelations } from "./index.js";
import { coredataMeta } from "./meta.js";
import { extractSwiftDataSources } from "../swift/data-sources.js";

const MODEL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<model type="com.apple.IDECoreDataModeler.DataModel" documentVersion="1.0">
    <entity name="Person" representedClassName="PersonMO" syncable="YES">
        <attribute name="name" attributeType="String"/>
        <relationship name="passport" optional="YES" maxCount="1" destinationEntity="Passport" inverseName="owner" inverseEntity="Passport"/>
        <relationship name="clubs" toMany="YES" destinationEntity="Club" inverseName="members" inverseEntity="Club"/>
        <relationship name="notes" toMany="YES" destinationEntity="Note"/>
    </entity>
    <entity name="Employee" representedClassName="Employee" parentEntity="Person" syncable="YES">
        <attribute name="salary" optional="YES" attributeType="Decimal"/>
    </entity>
    <entity name="Passport" representedClassName="Passport" syncable="YES">
        <relationship name="owner" maxCount="1" destinationEntity="Person" inverseName="passport" inverseEntity="Person"/>
    </entity>
    <entity name="Club" representedClassName="Club" syncable="YES">
        <relationship name="members" toMany="YES" destinationEntity="Person" inverseName="clubs" inverseEntity="Person"/>
    </entity>
    <entity name="Note" representedClassName="Note" syncable="YES"/>
</model>`;

describe("Core Data models", () => {
  it("names entities by their class, extends the parent entity, and reads each relationship's cardinality from its inverse", () => {
    const lines = MODEL.split("\n");
    expect(extractCoreDataEntities(lines).map((c) => `${c.name}${c.tableName ? `(${c.tableName})` : ""} < ${c.extends ?? "-"} [${c.properties.map((p) => `${p.name}:${p.type}`).join(", ")}]`)).toEqual([
      "PersonMO(Person) < - [name:String]",
      "Employee < PersonMO [salary:Decimal?]",
      "Passport < - []",
      "Club < - []",
      "Note < - []",
    ]);
    expect(extractCoreDataRelations(lines).map((r) => `${r.fromEntity}.${r.fromField} ${r.cardinality} ${r.toEntity}`)).toEqual([
      "PersonMO.passport one-to-one Passport",
      "PersonMO.clubs many-to-many Club",
      "PersonMO.notes one-to-many Note",
      "Passport.owner one-to-one PersonMO",
      "Club.members many-to-many PersonMO",
    ]);
  });

  it("claims only the contents of an .xcdatamodel bundle", () => {
    expect(coredataMeta.preprocess!(MODEL, "App/Model.xcdatamodeld/Model.xcdatamodel/contents")).toBeNull();
    expect(coredataMeta.preprocess!("table of contents", "docs/contents")).toEqual({ skip: "not a Core Data model" });
  });
});

describe("Swift Core Data access", () => {
  it("reads fetch requests and FetchedResults, and writes objects made in a context", () => {
    const rows = extractSwiftDataSources([
      "import SwiftUI",
      "import CoreData",
      "@FetchRequest(sortDescriptors: []) private var people: FetchedResults<Person>",
      'let r = NSFetchRequest<Club>(entityName: "Club")',
      "let all = Note.fetchRequest()",
      "let p = Person(context: viewContext)",
      'NSEntityDescription.insertNewObject(forEntityName: "Passport", into: ctx)',
      "let any = NSFetchRequest<NSManagedObject>(entityName: x)",
    ]).filter((d) => d.kind === "database").map((d) => `${d.line} ${d.access} ${d.entity}`);
    expect(rows).toEqual(["3 read Person", "4 read Club", "5 read Note", "6 write Person", "7 write Passport"]);
  });
});
