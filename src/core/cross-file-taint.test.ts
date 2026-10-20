import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

const files: Record<string, string> = {
  "py/requirements.txt": "flask==3.0.3\n",
  "py/app/views.py": `from flask import Flask, request
from app.db import run_query

app = Flask(__name__)

@app.route("/search")
def search():
    term = request.args.get("q")
    return run_query(term)

@app.route("/count")
def count():
    return run_query(str(int(request.args.get("n"))))
`,
  "py/app/db.py": `import sqlite3
conn = sqlite3.connect("app.db")

def run_query(text):
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM items WHERE name = '" + text + "'")
    return cursor.fetchall()
`,
  "js/package.json": JSON.stringify({ name: "js", dependencies: { express: "^4.19.0" } }),
  "js/src/shell.js": `const { exec } = require("child_process");
function convert(file) {
  exec("convert " + file + " out.png");
}
module.exports = { convert };
`,
  "js/src/routes.js": `const express = require("express");
const { convert } = require("./shell");
const app = express();
app.post("/convert", (req, res) => {
  convert(req.body.file);
  res.end();
});
`,
};

describe("request input followed into another file", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-xtaint-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, "src", rel, ".."), { recursive: true });
      await writeFile(join(dir, "src", rel), text);
    }
    out = join(dir, "out");
    await analyze({ projectRoot: join(dir, "src"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("reports at the sink in the callee's file, with the path through both, and not for a sanitized argument", async () => {
    const s = await loadReportSummary(out);
    const found = (s.securityIssues ?? []).filter((i) => i.category === "sql-injection" || i.category === "command-injection");
    expect(found.map((i) => `${i.category} ${i.filePath}:${i.line}`).sort()).toEqual(["command-injection js/src/shell.js:3", "sql-injection py/app/db.py:6"]);
    const sql = found.find((i) => i.category === "sql-injection")!;
    expect(sql.flow!.map((f) => `${f.file ?? sql.filePath}:${f.line} ${f.note}`)).toEqual([
      "py/app/views.py:8 request input read here; term carries it",
      "py/app/views.py:9 passed to run_query() as argument 1",
      "py/app/db.py:6 reaches the SQL text of cursor.execute()",
    ]);
  });
});
