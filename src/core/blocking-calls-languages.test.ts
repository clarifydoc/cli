import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

const FILES: Record<string, string> = {
  "cs/Svc.cs": [
    "using System.Threading;",
    "using System.Threading.Tasks;",
    "namespace League {",
    "  public class Club { public void Wait() {} }",
    "  public class Svc {",
    "    private Task<int> Load() => Task.FromResult(1);",
    "    public async Task Bad(Club club) {",
    "      Thread.Sleep(100);",
    "      var g = Load().GetAwaiter().GetResult();",
    "      club.Wait();",
    "    }",
    "    public void Sync(Club club) {",
    "      Thread.Sleep(100);",
    "      var g = Load().GetAwaiter().GetResult();",
    "      club.Wait();",
    "    }",
    "  }",
    "}",
  ].join("\n"),
  "kt/Svc.kt": [
    "package league",
    "class Club { fun runBlocking() {} fun sleep() {} }",
    "class Svc {",
    "  suspend fun bad(club: Club) {",
    "    Thread.sleep(100)",
    "    runBlocking { }",
    "    club.sleep()",
    "    club.runBlocking()",
    "  }",
    "  fun sync(club: Club) {",
    "    Thread.sleep(100)",
    "    runBlocking { }",
    "  }",
    "}",
  ].join("\n"),
  "rs/main.rs": [
    "use std::time::Duration;",
    "struct Club;",
    "impl Club { fn sleep(&self) {} }",
    "async fn bad(club: &Club) {",
    "    std::thread::sleep(Duration::from_secs(1));",
    '    let s = std::fs::read_to_string("a.txt");',
    "    club.sleep();",
    "}",
    "fn sync(club: &Club) {",
    "    std::thread::sleep(Duration::from_secs(1));",
    '    let s = std::fs::read_to_string("a.txt");',
    "}",
  ].join("\n"),
  "dart/main.dart": [
    "import 'dart:io';",
    "class Club { void sleep() {} String readAsStringSync() => ''; }",
    "Future<void> bad(Club club) async {",
    "  sleep(Duration(seconds: 1));",
    "  final s = File('a.txt').readAsStringSync();",
    "  club.readAsStringSync();",
    "  club.sleep();",
    "}",
    "void sync(Club club) {",
    "  sleep(Duration(seconds: 1));",
    "  final s = File('a.txt').readAsStringSync();",
    "}",
  ].join("\n"),
};

describe("blocking-in-async for C#, Kotlin, Rust and Dart", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-blocking-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(join(dir, "src", rel.split("/")[0]!), { recursive: true });
      await writeFile(join(dir, "src", rel), text);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags the blocking calls of async functions only, never a project method of the same name", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const got = (s.patterns ?? [])
      .filter((p) => p.kind === "blocking-in-async")
      .map((p) => `${p.filePath}:${p.line} ${p.name}`)
      .sort();
    expect(got).toEqual(
      [
        "cs/Svc.cs:8 Svc.Bad",
        "cs/Svc.cs:9 Svc.Bad",
        "dart/main.dart:4 bad",
        "dart/main.dart:5 bad",
        "kt/Svc.kt:5 Svc.bad",
        "kt/Svc.kt:6 Svc.bad",
        "rs/main.rs:5 bad",
        "rs/main.rs:6 bad",
      ].sort(),
    );
  });
});
