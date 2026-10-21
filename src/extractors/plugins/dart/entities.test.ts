import { describe, it, expect } from "vitest";
import { DartEntityExtractor } from "./entities.js";
import { dartSpec } from "./index.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const cls = (name: string, line: number, endLine: number, ext: string | null = null): any =>
  ({ name, extends: ext, implements: [], decorators: [], methods: [], properties: [], isExported: true, line, endLine });

describe("Dart ORM entities", () => {
  it("reads a Drift table with its columns, keys and references", () => {
    const src = `import 'package:drift/drift.dart';

class MemoryEntity extends Table with DriftDefaultsMixin {
  const MemoryEntity();
  TextColumn get id => text()();
  TextColumn get ownerId => text().references(PlayerEntity, #id, onDelete: KeyAction.cascade)();
  DateTimeColumn get createdAt => dateTime()();
  @override
  Set<Column> get primaryKey => {id};
}

@collection
class Asset {
  Id id = Isar.autoIncrement;
  late String name;
  final owner = IsarLink<Player>();
}`;
    const lines = src.split("\n");
    const analysis = { filePath: "memory.dart", classes: [cls("MemoryEntity", 3, 10, "Table"), cls("Asset", 13, 17)] } as unknown as FileAnalysis;
    const { entities, relations } = new DartEntityExtractor().extract({ analysis, sourceText: src, lines });
    expect(entities.map((e) => [e.name, e.decorators[1], e.properties.map((p) => p.name)])).toEqual([
      ["MemoryEntity", "drift", ["id", "ownerId", "createdAt"]],
      ["Asset", "isar", ["id", "name"]],
    ]);
    expect(relations).toEqual([
      { fromEntity: "MemoryEntity", fromField: "ownerId", toEntity: "PlayerEntity", cardinality: "many-to-one", foreignKey: "ownerId", orm: "drift", confidence: "EXTRACTED" },
      { fromEntity: "Asset", fromField: "owner", toEntity: "Player", cardinality: "many-to-one", orm: "isar", confidence: "EXTRACTED" },
    ]);
  });

  it("names the table a Drift or Isar access touches", () => {
    const rows = dartSpec.extractDataSources!([
      "final rows = await (_db.select(_db.playerEntity)..where((u) => u.id.equals(id))).get();",
      "await _db.remoteAssetEntity.delete().go();",
      "await db.managers.localAssetEntity.filter((f) => f.id(id)).delete();",
      "await isar.assets.put(asset);",
      "await _db.transaction(() async {});",
    ], []).filter((d) => d.kind === "database");
    expect(rows.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["select(playerEntity)", "PlayerEntity", "read"],
      ["db.remoteAssetEntity.delete", "RemoteAssetEntity", "write"],
      ["db.localAssetEntity.filter", "LocalAssetEntity", "read"],
      ["isar.assets.put", "Asset", "write"],
    ]);
  });
});
