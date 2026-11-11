import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Same-name precision: a call reaches the definition the language would run,
 * never a namesake that only shares its name — another class of the file, a
 * namespace twin, a companion member through an instance, an import the file
 * shadows, a method whose arity cannot accept the call.
 */
const FILES: Record<string, string> = {
  "py/requirements.txt": "flask==3.0.0\n",
  "py/league/util.py": `def rank(club):
    return 1
`,
  "py/league/table.py": `from league.util import rank

def rank(club):
    return 2

def table(club):
    return rank(club)
`,
  "kt/build.gradle.kts": `plugins { kotlin("jvm") version "1.9.0" }
`,
  "kt/src/main/kotlin/garage/Tools.kt": `package garage
fun polish(car: String) { println(car) }
`,
  "kt/src/main/kotlin/league/Main.kt": `package league
import garage.polish

fun polish(car: String) { println(car) }
fun wash() { polish("estate") }

open class Vehicle {
    open fun start() {}
}

class Truck : Vehicle() {
    companion object {
        fun start(): Truck = Truck()
        fun build(): Truck = Truck()
    }
}

fun drive(t: Truck) {
    t.start()
    t.build()
    Truck.build()
}
`,
  "cs/League.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>
`,
  "cs/App/Squad.cs": `using static App.Rules;
namespace App;

public static class Rules
{
    public static void Check() { }
}

public class Scout
{
    public void Report() { }
}

public class Staff
{
    protected void Brief() { }
}

public class Coach : Staff
{
    public void Train()
    {
        Report();
        Brief();
        Check();
    }
}

public partial class Physio
{
    public void Treat() { Stretch(); }
}

public partial class Physio
{
    private void Stretch() { }
}
`,
  "cs/App/Twins.cs": `namespace Home
{
    public class Kit
    {
        public void Wear() { Wash(); }
    }
}

namespace Away
{
    public class Kit
    {
        public void Wash() { }
    }
}
`,
  "cs/A/Ball.cs": `namespace A;
public class Ball { public Ball() { } }
`,
  "cs/B/Ball.cs": `namespace B;
public class Ball { public Ball() { } }
`,
  "cs/A/Pitch.cs": `namespace A;
public class Pitch
{
    public void Setup()
    {
        var b = new B.Ball();
        var n = new Models.Net<int>();
    }
}
`,
  "cs/Models/Net.cs": `namespace Models;
public class Net<T> { public Net() { } }
`,
  "java/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>league</artifactId><version>1</version></project>
`,
  "java/src/main/java/com/example/league/Scorer.java": `package com.example.league;
public class Scorer {
    public void format(int level, String... lines) { }
    public void save(Club c) { }
    public void save(Player p) { }
}
`,
  "java/src/main/java/com/example/league/Club.java": `package com.example.league;
public class Club { }
`,
  "java/src/main/java/com/example/league/Formation.java": `package com.example.league;
public class Formation {
    private Formation left;
    private Formation right;
    public boolean has(String role) {
        return role.isEmpty() || has(left, role) || has(right, role);
    }
    private boolean has(Formation side, String role) {
        return side != null && side.has(role);
    }
    public static Formation of(String name, String... roles) { return new Formation(); }
    public static Formation of(String name, boolean home, String... roles) { return new Formation(); }
    public void pair() { java.util.List.of(of("away", "keeper", "striker"), of("home", "keeper")); }
}
`,
  "java/src/main/java/com/example/league/Player.java": `package com.example.league;
public class Player { }
`,
  "java/src/main/java/com/example/league/Match.java": `package com.example.league;
public class Match {
    private Scorer scorer;
    public void full() {
        scorer.format(1, "goal");
    }
    public void none() {
        scorer.format();
    }
    public void keep(Object anything) {
        scorer.save(anything);
    }
}
`,
};

describe("same-name precision in the symbol linker", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-namesakes-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The calls `symbol` in `file` makes, as `callName -> file::target [confidence]`. */
  const from = (file: string, symbol: string) => summary.symbolLinks
    .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.strategy !== "reference")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}${l.confidence === "AMBIGUOUS" ? " [AMBIGUOUS]" : ""}`)
    .sort();

  it("a function the file declares wins over an import of its name (Python, Kotlin)", () => {
    expect(from("py/league/table.py", "table")).toEqual(["rank -> py/league/table.py::rank"]);
    expect(from("kt/src/main/kotlin/league/Main.kt", "wash")).toEqual(["polish -> kt/src/main/kotlin/league/Main.kt::polish"]);
  });

  it("C#: a bare call reaches the class, its bases or a `using static` type — never another class of the file", () => {
    expect(from("cs/App/Squad.cs", "Coach.Train")).toEqual([
      "Brief -> cs/App/Squad.cs::Staff.Brief",
      "Check -> cs/App/Squad.cs::Rules.Check",
    ]);
    expect(from("cs/App/Squad.cs", "Physio.Treat")).toEqual(["Stretch -> cs/App/Squad.cs::Physio.Stretch"]);
  });

  it("C#: a class of one name in two namespaces of a file is two classes", () => {
    expect(from("cs/App/Twins.cs", "Kit.Wear")).toEqual([]);
  });

  it("C#: `new B.Ball()` is the class the namespace written declares; type arguments name no class", () => {
    expect(from("cs/A/Pitch.cs", "Pitch.Setup")).toEqual([
      "new B.Ball -> cs/B/Ball.cs::Ball.Ball",
      "new Models.Net<int> -> cs/Models/Net.cs::Net.Net",
    ]);
  });

  it("Kotlin: a companion member is called on the class, never on a value — the value reaches its base's", () => {
    expect(from("kt/src/main/kotlin/league/Main.kt", "drive")).toEqual([
      "Truck.build -> kt/src/main/kotlin/league/Main.kt::Truck.build",
      "t.start -> kt/src/main/kotlin/league/Main.kt::Vehicle.start",
    ]);
  });

  it("Java: a call no arity of the method accepts reaches nothing; a varargs call past the fixed prefix does", () => {
    expect(from("java/src/main/java/com/example/league/Match.java", "Match.full")).toEqual([
      "scorer.format -> java/src/main/java/com/example/league/Scorer.java::Scorer.format",
    ]);
    expect(from("java/src/main/java/com/example/league/Match.java", "Match.none")).toEqual([]);
  });

  it("Java: calls of one name on one line choose an overload when they all agree on it", () => {
    const at = (sym: string, call: string) => summary.symbolLinks.filter((l) => l.sourceSymbol === sym && l.callName === call).map((l) => l.targetLine);
    // `has(left, role) || has(right, role)`: both two-argument calls, so the two-argument overload.
    expect(at("Formation.has", "has")).toEqual([8]);
    // `of("away", "keeper", "striker")` and `of("home", "keeper")`: neither fits a boolean second parameter.
    expect(at("Formation.pair", "of")).toEqual([11]);
  });

  it("overloads the arguments cannot tell apart: the method is linked, said to be one of several bodies", () => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === "Match.keep" && l.callName === "scorer.save");
    expect(link?.targetSymbol).toBe("Scorer.save");
    expect(link?.overloadsFit).toBe(2);
    expect(link?.confidence).not.toBe("AMBIGUOUS");
  });
});
