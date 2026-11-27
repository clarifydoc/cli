import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";
import { parseUdl } from "../extractors/plugins/rust/uniffi-bindings.js";

/**
 * Kotlin and Swift apps calling Rust crates through uniffi's generated bindings (absent from the tree): one crate
 * with proc macros and a `uniffi.toml` naming its Kotlin package, one declared by a UDL file. Decoys: a Rust
 * function without the export, a Kotlin and a Swift function of the same name that import no binding, a file
 * importing another package, a method the export attribute does not reach, and a function the UDL leaves out.
 */
const FILES: Record<string, string> = {
  "league/Cargo.toml": `[package]\nname = "league-kit"\n[dependencies]\nuniffi = "0.28"\n`,
  "league/uniffi.toml": `[bindings.kotlin]\npackage_name = "com.example.league.bindings"\n`,
  "league/src/lib.rs": `uniffi::setup_scaffolding!();

#[uniffi::export]
pub fn start_match(club_id: u32) -> String {
    String::new()
}

pub fn end_match(club_id: u32) {}

#[derive(uniffi::Object)]
pub struct Garage {
    spaces: u32,
}

#[uniffi::export]
impl Garage {
    #[uniffi::constructor]
    pub fn new(spaces: u32) -> Self {
        Garage { spaces }
    }

    pub fn park_car(&self, car: String) {}

    fn lock_up(&self) {}
}

impl Garage {
    pub fn wash_car(&self) {}
}
`,
  "garage/Cargo.toml": `[package]\nname = "garage-kit"\n[dependencies]\nuniffi = "0.28"\n`,
  "garage/src/lib.rs": `uniffi::include_scaffolding!("garage");

pub fn open_garage(name: String) -> u32 {
    0
}

pub fn close_garage() {}

pub struct Car {}

impl Car {
    pub fn new() -> Self {
        Car {}
    }
    pub fn with_color(color: String) -> Self {
        Car {}
    }
    pub fn drive(&self) {}
    pub fn wax(&self) {}
}
`,
  "garage/src/garage.udl": `namespace garage {
  u32 open_garage(string name);
};

interface Car {
  constructor();
  [Name=with_color] constructor(string color);
  void drive();
};
`,
  "android/app/Screen.kt": `package com.example.app

import com.example.league.bindings.startMatch
import com.example.league.bindings.Garage

class Screen {
    fun go() {
        startMatch(3u)
        val g = Garage(2u)
        g.parkCar("x")
        g.washCar()
        g.lockUp()
    }
}
`,
  "android/app/Garages.kt": `package com.example.app

import uniffi.garage.*
import com.example.league.bindings.*

class Garages {
    fun go() {
        openGarage("north")
        closeGarage()
        endMatch(1u)
        val c = Car()
        c.drive()
        c.wax()
        Car.withColor("red")
        startMatch(1u)
    }
}
`,
  "android/other/Decoy.kt": `package com.example.other

import uniffi.unrelated.*

fun startMatch(id: UInt): String = ""
fun openGarage(name: String): UInt = 0u

class Decoy {
    fun go() {
        startMatch(1u)
        openGarage("x")
    }
}
`,
  "android/other/NoImport.kt": `package com.example.league.bindings

class NoImport {
    fun go() {
        startMatch(1u)
    }
}
`,
  "ios/App/View.swift": `import league_kit
import garage

func go() {
    let g = Garage(spaces: 2)
    g.parkCar(car: "x")
    startMatch(clubId: 3)
    openGarage(name: "north")
}
`,
  "ios/Kit/Package.swift": `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LeagueKit",
    targets: [
        .target(name: "LeagueKit", dependencies: ["league_kitFFI"], path: "Sources/LeagueKit"),
        .target(name: "Escaped", dependencies: ["league_kitFFI"], path: "../Escaped"),
        .target(name: "Scouting", dependencies: ["LeagueKit"]),
        .binaryTarget(name: "league_kitFFI", path: "Frameworks/League.xcframework"),
    ]
)
`,
  "ios/Kit/Sources/LeagueKit/Wrapper.swift": `func kickOff() {
    startMatch(clubId: 1)
}
`,
  "ios/Kit/Sources/Scouting/Uses.swift": `import LeagueKit

func scout() {
    startMatch(clubId: 2)
}
`,
  "ios/Kit/Sources/Scouting/Decoy.swift": `func other() {
    startMatch(clubId: 5)
}
`,
  "ios/Escaped/File.swift": `func escaped() {
    startMatch(clubId: 6)
}
`,
  "ios/Demo/Demo.swift": `import league_kitFFI

func demo() {
    startMatch(clubId: 3)
}
`,
  "ios/Other/Decoy.swift": `func startMatch(clubId: Int) -> String { "" }

func decoy() {
    startMatch(clubId: 1)
}
`,
};

describe("uniffi bindings", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-uniffi-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "src", path)), { recursive: true });
      await writeFile(join(dir, "src", path), text);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const links = (from: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === from && l.strategy === "dispatch:foreign-binding")
      .map((l) => `${l.sourceLine} ${l.callName} → ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("joins a Kotlin call through the package uniffi.toml names, to exports only", () => {
    expect(links("android/app/Screen.kt")).toEqual([
      "10 g.parkCar → league/src/lib.rs::Garage.park_car",
      "8 startMatch → league/src/lib.rs::start_match",
      "9 Garage → league/src/lib.rs::Garage.new",
    ]);
  });

  it("joins a star import of a UDL crate's package, to what the UDL declares", () => {
    expect(links("android/app/Garages.kt")).toEqual([
      "11 Car → garage/src/lib.rs::Car.new",
      "12 c.drive → garage/src/lib.rs::Car.drive",
      "14 Car.withColor → garage/src/lib.rs::Car.with_color",
      "15 startMatch → league/src/lib.rs::start_match",
      "8 openGarage → garage/src/lib.rs::open_garage",
    ]);
  });

  it("joins a Swift call through the module the crate names, and no namesake", () => {
    expect(links("ios/App/View.swift")).toEqual([
      "5 Garage → league/src/lib.rs::Garage.new",
      "6 g.parkCar → league/src/lib.rs::Garage.park_car",
      "7 startMatch → league/src/lib.rs::start_match",
      "8 openGarage → garage/src/lib.rs::open_garage",
    ]);
    expect(links("ios/Other/Decoy.swift")).toEqual([]);
  });

  it("joins Swift through the package target wrapping the generated file and the generated FFI module", () => {
    expect(links("ios/Kit/Sources/LeagueKit/Wrapper.swift")).toEqual(["2 startMatch → league/src/lib.rs::start_match"]);
    expect(links("ios/Kit/Sources/Scouting/Uses.swift")).toEqual(["4 startMatch → league/src/lib.rs::start_match"]);
    expect(links("ios/Demo/Demo.swift")).toEqual(["4 startMatch → league/src/lib.rs::start_match"]);
  });

  it("links nothing from a target without the dependency, or whose manifest path leaves its package", () => {
    expect(links("ios/Kit/Sources/Scouting/Decoy.swift")).toEqual([]);
    expect(links("ios/Escaped/File.swift")).toEqual([]);
  });

  it("links nothing from code that imports no binding or another package", () => {
    expect(links("android/other/Decoy.kt")).toEqual([]);
    expect(links("android/other/NoImport.kt")).toEqual([]);
  });
});

describe("parseUdl", () => {
  it("reads the namespace, its functions, and each interface's constructors and methods", () => {
    const { namespace, declared } = parseUdl(`// comment
namespace garage {
  u32 open_garage(string name);
};
[Trait] interface Car {
  constructor();
  [Name=with_color] constructor(string color);
  void drive();
};
dictionary Spec { string name; };`);
    expect(namespace).toBe("garage");
    expect(declared).toEqual({ functions: ["open_garage"], classes: [{ name: "Car", methods: ["with_color", "drive"], constructors: ["new"] }] });
  });
});
