import { describe, it, expect } from "vitest";
import { spawnedScripts } from "./process-spawns.js";

const paths = (text: string, lang: "js" | "python" | "go") => spawnedScripts(text, lang).map((s) => `${s.line}:${s.path}`);

describe("process spawns", () => {
  it("JS: fork, spawn arguments, command lines, worker threads, paths joined on __dirname", () => {
    expect(paths(`import { fork, spawn, execSync } from "node:child_process";
import { Worker } from "node:worker_threads";
fork("./worker.js");
spawn("node", ["tools/load.js", "--fresh"]);
execSync("python tools/gen.py --out x");
const w = new Worker(new URL("./resize.js", import.meta.url));
spawn(process.execPath, [path.join(__dirname, "jobs", "nightly.js")]);
spawn("git", ["status"]);
const m = /x/.exec("a.js");`, "js")).toEqual(["3:./worker.js", "4:tools/load.js", "5:tools/gen.py", "6:./resize.js", "7:./jobs/nightly.js"]);
    expect(paths(`fork("./worker.js")`, "js")).toEqual([]);
  });

  it("Python: subprocess lists and command strings, paths joined on __file__", () => {
    expect(paths(`import os, subprocess, sys
subprocess.run([sys.executable, "tools/gen.py"], check=True)
os.system("bash deploy.sh")
subprocess.Popen(["python", os.path.join(os.path.dirname(__file__), "migrate.py")])
subprocess.run(["ls", "-la"])`, "python")).toEqual(["2:tools/gen.py", "3:deploy.sh", "4:./migrate.py"]);
  });

  it("Go: exec.Command with a script", () => {
    expect(paths(`cmd := exec.Command("python3", "scripts/report.py")
run := exec.CommandContext(ctx, "./scripts/run.sh", "--all")
exec.Command("git", "pull")`, "go")).toEqual(["1:scripts/report.py", "2:./scripts/run.sh"]);
  });
});
