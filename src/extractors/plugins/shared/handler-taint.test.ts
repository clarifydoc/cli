import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { pythonTaint } from "../python/taint.js";
import { javascriptTaint } from "../javascript/taint.js";

async function py(src: string) {
  return pythonTaint(await parseSource(src, "python" as never, "app/views.py"), src, "app/views.py").map((i) => [i.category, i.line]);
}
async function js(src: string) {
  return javascriptTaint(await parseSource(src, "javascript" as never, "src/routes.js"), src, "src/routes.js").map((i) => [i.category, i.line]);
}

describe("handler taint — Python", () => {
  it("follows Flask request input through assignments to the sinks", async () => {
    expect(await py(`
@app.route("/report")
def report():
    name = request.args.get("name")
    path = os.path.join(BASE, name)
    with open(path) as f:
        data = f.read()
    url = request.args["callback"]
    requests.get(url)
    return redirect(request.args.get("next"))
`)).toEqual([["path-traversal", 6], ["ssrf", 9], ["open-redirect", 10]]);
  });

  it("taints FastAPI parameters but not validated, injected or typed ones", async () => {
    expect(await py(`
@router.get("/items")
def items(q: str, limit: int, db: Session = Depends(get_db)):
    db.execute(f"SELECT * FROM items WHERE name = '{q}' LIMIT {limit}")
    db.execute(f"SELECT * FROM items LIMIT {limit}")
`)).toEqual([["sql-injection", 4]]);
  });

  it("stops at a sanitizer, a reassignment, and a parameterized query", async () => {
    expect(await py(`
def view(request):
    uid = int(request.GET["id"])
    cursor.execute(f"SELECT * FROM t WHERE id = {uid}")
    name = request.GET["name"]
    cursor.execute("SELECT * FROM t WHERE name = %s", (name,))
    cmd = request.GET["cmd"]
    cmd = "ls"
    os.system(cmd)
    safe = shlex.quote(request.GET["arg"])
    os.system("echo " + safe)
`)).toEqual([]);
  });

  it("treats a checked value as safe, and does not follow an arbitrary function's result", async () => {
    expect(await py(`
@router.get("/files/{name}")
def get_file(name: str, kind: ImageType):
    if not name.startswith("audit_"):
        raise HTTPException(400)
    open(os.path.join(BASE, name))
    out = service.render(kind, name)
    open(out)
    url = request.args["next"]
    if url_has_allowed_host_and_scheme(url, allowed_hosts=None):
        return redirect(url)
`)).toEqual([]);
  });

  it("does not treat a function without request input as a handler", async () => {
    expect(await py(`
def helper(name):
    os.system("echo " + name)
`)).toEqual([]);
  });
});

describe("handler taint — Express", () => {
  it("follows req input, destructuring included, to the sinks", async () => {
    expect(await js(`
app.get("/files", async (req, res) => {
  const { file } = req.query;
  const full = path.join(ROOT, file);
  res.sendFile(full);
  const rows = await db.query("SELECT * FROM t WHERE id = " + req.params.id);
  const ok = await db.query("SELECT * FROM t WHERE id = $1", [req.params.id]);
  exec(\`convert \${req.body.name}\`);
  res.redirect(req.query.next);
});
`)).toEqual([["path-traversal", 5], ["sql-injection", 6], ["command-injection", 8], ["open-redirect", 9]]);
  });

  it("honours an early-exit guard", async () => {
    expect(await js(`
router.get("/f", (req, res) => {
  const resolved = path.resolve(ROOT, req.query.path);
  if (!resolved.startsWith(ROOT + path.sep)) throw new Error("no");
  res.sendFile(resolved);
});
`)).toEqual([]);
  });

  it("clears taint through parseInt", async () => {
    expect(await js(`
router.get("/n", (req, res) => {
  const n = parseInt(req.query.n, 10);
  db.query("SELECT * FROM t LIMIT " + n);
});
`)).toEqual([]);
  });
});
