import { describe, it, expect } from "vitest";
import { extractPrismaModels } from "./index.js";

describe("Prisma @map / @@map", () => {
  it("reads the column of @map and the table of @@map in both argument forms", () => {
    const classes = extractPrismaModels(`model Club {
  id        Int    @id
  shortName String @map("short_name")
  @@map(name: "clubs")
}
model Player {
  id Int @id
  @@map("players")
}`.split("\n"));
    const club = classes.find((c) => c.name === "Club")!;
    expect(club.tableName).toBe("clubs");
    expect(club.properties.map((p) => p.column ?? null)).toEqual([null, "short_name"]);
    expect(classes.find((c) => c.name === "Player")!.tableName).toBe("players");
  });
});
