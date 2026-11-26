import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Member effects of a type written through a qualifier: Dart `throw io.Error()` and C#/Go types named with their
 * namespace or package. The qualifier says which class is meant, so a namesake of another namespace is never
 * bound, and a qualifier naming a library binds no project class.
 */
async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-qualified-"));
  const root = join(dir, "app");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

describe("Dart throw through an import prefix", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "pubspec.yaml": "name: league\n",
      "lib/errors/cup.dart": "class RefereeError implements Exception {}\n",
      "lib/errors/league.dart": "class RefereeError implements Exception {}\n",
      "lib/play.dart": [
        "import 'dart:io' as io;",
        "import 'errors/cup.dart' as cup;",
        "class RefereeError implements Exception {}",
        "void a() { throw io.RefereeError(); }",
        "void b() { throw cup.RefereeError(); }",
        "void c() { throw RefereeError(); }",
      ].join("\n"),
    }));
  }, 60_000);
  afterAll(() => done());

  it("states the prefix; a library prefix binds no project class, a project one binds its own", () => {
    const rows = (summary.thrownTypes ?? []).map((t) => `${t.type} <- ${t.function} ${t.classFile ?? "-"}`).sort();
    expect(rows).toEqual([
      "RefereeError <- c lib/play.dart",
      "cup.RefereeError <- b lib/errors/cup.dart",
      "io.RefereeError <- a -",
    ].sort());
  });
});

describe("C# types written through their namespace", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Garage.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n",
      "Models/Car.cs": "namespace Garage.Models { public class Car { public int Speed; } public class PitError : System.Exception {} }\n",
      "Other/Car.cs": "namespace Garage.Other { public class Car { public int Speed; } public class PitError : System.Exception {} }\n",
      "Run/Driver.cs": [
        "namespace Garage.Run {",
        "  public class Driver {",
        "    public void A() { Garage.Models.Car car = new Garage.Models.Car(); car.Speed = 1; }",
        "    public void B(Garage.Other.Car car) { car.Speed = 2; }",
        "    public void C() { throw new Garage.Models.PitError(); }",
        "    public void D() { throw new Vendor.Lib.PitError(); }",
        "  }",
        "}",
      ].join("\n"),
      "Run/Imported.cs": "using Garage.Models;\nnamespace Garage.Run { public class Imported { public void E(Car car) { car.Speed = 3; } } }\n",
      "Run/Stranger.cs": "namespace Garage.Run { public class Stranger { public void F(Car car) { car.Speed = 4; } } }\n",
      "Run/Beside.cs": "namespace Garage.Other { public class Beside { public void G(Car car) { car.Speed = 5; } } }\n",
    }));
  }, 60_000);
  afterAll(() => done());

  it("a write through a qualified type reaches the field of the class in that namespace", () => {
    expect((summary.fieldWrites ?? []).map((w) => `${w.function} -> ${w.classFile}`).sort()).toEqual([
      "Driver.A -> Models/Car.cs",
      "Driver.B -> Other/Car.cs",
      "Imported.E -> Models/Car.cs",
      "Beside.G -> Other/Car.cs",
    ].sort());
  });
  it("a qualified throw binds the class of that namespace, never a library's namesake", () => {
    expect((summary.thrownTypes ?? []).map((t) => `${t.function} ${t.classFile ?? "-"}`).sort()).toEqual([
      "Driver.C Models/Car.cs",
      "Driver.D -",
    ]);
  });
});

describe("Go types written through their package", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "go.mod": "module example.com/garage\n\ngo 1.21\n",
      "models/car.go": "package models\n\ntype Car struct {\n\tSpeed int\n}\n",
      "other/car.go": "package other\n\ntype Car struct {\n\tSpeed int\n}\n",
      "run/driver.go": [
        "package run",
        "",
        "import (",
        "\t\"example.com/garage/models\"",
        "\t\"example.com/garage/other\"",
        ")",
        "",
        "func A(c *models.Car) { c.Speed = 1 }",
        "func B(c *other.Car) { c.Speed = 2 }",
        "func C(c *Car) { c.Speed = 3 }",
      ].join("\n"),
    }));
  }, 60_000);
  afterAll(() => done());

  it("a write through a package-qualified type reaches that package's struct", () => {
    expect((summary.fieldWrites ?? []).map((w) => `${w.function} -> ${w.classFile}`).sort()).toEqual([
      "A -> models/car.go",
      "B -> other/car.go",
    ]);
  });
});
