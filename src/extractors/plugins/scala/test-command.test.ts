import { describe, expect, it } from "vitest";
import { scalaTestCommand } from "./test-command.js";
import { scalaProjectCommands } from "./project-commands.js";
import type { ProjectRootView } from "../../../types/language-plugin.js";

const root = (files: Record<string, string>): ProjectRootView => ({ entries: Object.keys(files), read: (r) => files[r], exists: (r) => r in files });

describe("Scala test command", () => {
  it("runs each test file as the suite class it declares", () => {
    expect(scalaTestCommand([{ file: "src/test/scala/league/ClubSpec.scala", names: ["ClubSpec.creates"] }])).toBe('sbt "testOnly *ClubSpec"');
    expect(scalaTestCommand([{ file: "src/test/scala/league/PlayerTest.scala", names: [] }, { file: "src/test/scala/league/ClubSpec.scala", names: [] }])).toBe('sbt "testOnly *ClubSpec *PlayerTest"');
  });

  it("a file named for no class runs the whole build's tests", () => {
    expect(scalaTestCommand([{ file: "src/test/scala/package-info.scala", names: [] }])).toBe("sbt test");
  });

  it("sbt builds and tests; a Play build also runs", () => {
    expect(scalaProjectCommands(root({ "build.sbt": 'name := "league"' }))).toEqual([
      { kind: "build", command: "sbt compile", source: "build.sbt" },
      { kind: "test", command: "sbt test", source: "build.sbt" },
    ]);
    expect(scalaProjectCommands(root({ "build.sbt": "enablePlugins(PlayScala)" })).map((c) => c.kind)).toContain("start");
    expect(scalaProjectCommands(root({ "build.sbt": "// enablePlugins(PlayScala)" })).map((c) => c.kind)).not.toContain("start");
    expect(scalaProjectCommands(root({}))).toEqual([]);
  });
});
