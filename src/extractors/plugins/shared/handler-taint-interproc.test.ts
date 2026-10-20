import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { pythonTaint } from "../python/taint.js";
import { javascriptTaint } from "../javascript/taint.js";

async function py(src: string) {
  return pythonTaint(await parseSource(src, "python" as never, "app/views.py"), src, "app/views.py");
}
async function js(src: string) {
  return javascriptTaint(await parseSource(src, "javascript" as never, "src/routes.js"), src, "src/routes.js");
}

describe("handler taint across the file's functions", () => {
  it("Python: input passed to a helper reaches its sink, with the whole path", async () => {
    const issues = await py(`
@app.route("/search")
def search():
    term = request.args.get("q")
    return run_query(term)

def run_query(text):
    cursor.execute("SELECT * FROM items WHERE name = '" + text + "'")

def safe_query(text):
    cursor.execute("SELECT * FROM items WHERE name = %s", (text,))

@app.route("/safe")
def safe():
    return safe_query(request.args.get("q"))
`);
    expect(issues.map((i) => [i.category, i.line])).toEqual([["sql-injection", 8]]);
    expect(issues[0]!.flow!.map((s) => `${s.line}: ${s.note}`)).toEqual([
      "4: request input read here; term carries it",
      "5: passed to run_query() as text",
      "8: reaches the SQL text of cursor.execute()",
    ]);
  });

  it("Python: a builder that returns its tainted argument taints the caller's result; self.method is followed", async () => {
    expect((await py(`
class Reports(View):
    def get(self, request):
        name = request.GET["name"]
        sql = build_sql(name)
        cursor.execute(sql)
        self.export(name)
        cursor.execute(build_sql(int(request.GET["n"])))

    def export(self, label):
        os.system("tar czf " + label)

def build_sql(value):
    return "SELECT * FROM reports WHERE name = '" + value + "'"
`)).map((i) => [i.category, i.line])).toEqual([["sql-injection", 6], ["command-injection", 11]]);
  });

  it("JS: an Express handler's input followed into a same-file function", async () => {
    expect((await js(`
const { exec } = require("child_process");
function convert(file) {
  exec("convert " + file + " out.png");
}
app.post("/convert", (req, res) => {
  convert(req.body.file);
  res.end();
});
`)).map((i) => [i.category, i.line])).toEqual([["command-injection", 4]]);
  });
});
