import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A config file the code opens by a literal path is joined to it (`configFiles`); namesakes and variables are not. */
const FILES: Record<string, string> = {
  "pom.xml": `<project><modules><module>app</module><module>billing</module></modules></project>
`,
  "app/pom.xml": `<project><artifactId>app</artifactId></project>
`,
  "billing/pom.xml": `<project><artifactId>billing</artifactId></project>
`,
  "app/config/league.json": `{ "season": 38 }
`,
  "app/config/cup.yml": `rounds: 6
`,
  "app/config/unread.json": `{ "x": 1 }
`,
  "billing/config/league.json": `{ "fee": 3 }
`,
  "app/src/main/java/com/example/league/Loader.java": `package com.example.league;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;

public class Loader {
    private final String name = "league";

    public void load(String dynamic, String dir) {
        File a = new File("config/league.json");
        Path b = Paths.get("config", "cup.yml");
        File c = new File(dir, "unread.json");
        File d = new File("config/" + dynamic);
        File e = new File("/etc/league.json");
        Path f = Path.of("config/unknown.json");
    }
}
`,
  "app/src/main/java/com/example/league/Other.java": `package com.example.league;

public class Other {
    public void load() {
        File a = new File("config/unread.json");
    }
}
`,
  "app/src/main/kotlin/com/example/league/Fixture.kt": `package com.example.league

import java.io.File

class Fixture {
    fun load(name: String) = File("config/league.json").readText() + File("config/$name").readText()
}
`,
  "app/tools/seed.py": `import json
import os
from pathlib import Path


def seed(path, club):
    a = open("config/league.json")
    b = Path("config", "cup.yml")
    c = os.path.join("config", "league.json")
    d = open(path)
    e = open(f"config/{club}")
    f = club.open("config/unread.json")
    g = open("config/missing.json", "r")
    return json.load(a), b, c, d, e, f, g
`,
  "app/web/server.js": `const fs = require("fs");
const path = require("path");

const a = JSON.parse(fs.readFileSync("./config/league.json", "utf8"));
const b = fs.readFileSync(path.join(__dirname, "..", "config", "cup.yml"));
const c = fs.readFileSync(path.join(__dirname, "config", "league.json"));
const d = cache.readFile("config/unread.json");
const e = fs.readFileSync(\`config/\${name}\`);
const f = fs.readFileSync(process.env.LEAGUE_FILE);
`,
};

async function scan(files: Record<string, string>): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-config-files-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "src", rel)), { recursive: true });
    await writeFile(join(dir, "src", rel), text);
  }
  await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

describe("config file reads", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ dir, summary } = await scan(FILES));
  }, 180_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const row = (file: string) => summary.configFiles?.find((r) => r.file === file);

  it("joins a Java File / Paths.get path to the file at the sub-project root, and a Kotlin File", () => {
    expect(row("app/config/league.json")?.consumers.map((c) => [c.file.split("/").pop(), c.line])).toEqual(expect.arrayContaining([["Fixture.kt", 6], ["Loader.java", 11]]));
    expect(row("app/config/cup.yml")?.consumers.map((c) => [c.file.split("/").pop(), c.line])).toContainEqual(["Loader.java", 12]);
  });

  it("joins a Python open and Path built from literals", () => {
    const consumers = (file: string) => row(file)?.consumers.map((c) => [c.file.split("/").pop(), c.line]) ?? [];
    expect(consumers("app/config/league.json")).toEqual(expect.arrayContaining([["seed.py", 7], ["seed.py", 9]]));
    expect(consumers("app/config/cup.yml")).toContainEqual(["seed.py", 8]);
  });

  it("joins a JS fs read and a path.join from __dirname, and nothing for another receiver", () => {
    const consumers = (file: string) => row(file)?.consumers.filter((c) => c.file.endsWith("server.js")).map((c) => c.line);
    expect(consumers("app/config/league.json")).toEqual([4]);
    expect(consumers("app/config/cup.yml")).toEqual([5]);
  });

  it("joins nothing for a variable, a concatenation, an absolute path or a file the analysis lacks", () => {
    expect(row("app/config/unread.json")).toBeUndefined();
    expect(summary.configFiles?.map((r) => r.file)).toEqual(["app/config/cup.yml", "app/config/league.json"]);
  });

  it("keeps the namesake of another module apart", () => {
    expect(row("billing/config/league.json")).toBeUndefined();
  });
});
