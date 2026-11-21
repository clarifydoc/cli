import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function findings(src: string, rel = "club/handlers.go"): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "go-taint-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "go-taint-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "go" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return (result!.analysis.securityIssues ?? []).filter((i) => i.message.startsWith("Request input")).map((i) => `${i.line} ${i.category}`);
}

describe("handler taint — Go", () => {
  it("follows Gin, Echo and net/http input to SQL, command, path, URL and redirect sinks", async () => {
    expect(await findings(`package club

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"

	"github.com/gin-gonic/gin"
)

func ListPlayers(c *gin.Context) {
	name := c.Query("name")
	q := "SELECT * FROM players WHERE name = '" + name + "'"
	rows, _ := db.Query(q)
	_ = rows
}

func SearchClubs(c *gin.Context) {
	db.Exec(fmt.Sprintf("DELETE FROM clubs WHERE id = %s", c.Param("id")))
}

func RunReport(c *gin.Context) {
	exec.Command("sh", "-c", "report "+c.PostForm("kind")).Run()
}

func Download(w http.ResponseWriter, r *http.Request) {
	f, _ := os.Open("/data/" + r.URL.Query().Get("file"))
	_ = f
	http.Redirect(w, r, r.FormValue("next"), 302)
}

func Serve(c *gin.Context) {
	c.File("/data/" + c.Query("f"))
	os.Open(filepath.Clean(c.Query("g")))
	http.Get("https://" + c.Query("host") + "/api")
	if _, ok := allowed[c.Query("sort")]; !ok {
		return
	}
	db.Raw("SELECT " + c.Query("name"))
}

func Fetch(c *gin.Context) {
	resp, _ := http.Get(c.Query("url"))
	_ = resp
}
`)).toEqual(["17 sql-injection", "22 sql-injection", "26 command-injection", "30 path-traversal", "32 open-redirect", "36 path-traversal", "37 path-traversal", "38 ssrf", "42 sql-injection", "46 ssrf"]);
  });

  it("leaves parameterised queries, parsed values, file-name calls and checked values alone", async () => {
    expect(await findings(`package club

import (
	"database/sql"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

func ListPlayers(c *gin.Context) {
	name := c.Query("name")
	db.Query("SELECT * FROM players WHERE name = $1", name)
	db.QueryRow("SELECT * FROM players WHERE name = ?", c.Param("id"))
}

func Parsed(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return
	}
	db.Exec(fmt.Sprintf("DELETE FROM clubs WHERE id = %d", id))
}

func Command(c *gin.Context) {
	exec.Command("git", "log", c.Query("branch")).Run()
	exec.Command("sh", "-c", "date").Run()
}

func Path(c *gin.Context) {
	os.Open(filepath.Join("/data", filepath.Base(c.Query("file"))))
}

func Redirect(w http.ResponseWriter, r *http.Request) {
	next := r.FormValue("next")
	if !strings.HasPrefix(next, "/") {
		next = "/"
	}
	http.Redirect(w, r, next, 302)
}

func Sort(c *gin.Context) {
	col := c.Query("sort")
	if _, ok := allowed[col]; !ok {
		return
	}
	db.Query("SELECT * FROM players ORDER BY " + col)
}

func Forward(w http.ResponseWriter, r *http.Request) {
	target := baseURL + r.URL.Path
	http.Redirect(w, r, target, 302)
	resp, _ := http.Get(upstream + r.URL.Query().Get("p"))
	_ = resp
}

func Cleaned(c *gin.Context) {
	token := clean.Token(c.Param("token"))
	os.Stat(filepath.Join("/cache", token))
}

func Checked(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.FormValue("next"), "/") {
		return
	}
	http.Redirect(w, r, r.FormValue("next"), 302)
}

func NotAHandler(db *sql.DB, name string) {
	db.Query("SELECT * FROM players WHERE name = '" + name + "'")
}

func Named(c *gin.Context, repo Repo) {
	repo.Query(c.Query("name"))
	c.Query("x")
}
`)).toEqual([]);
  });

  it("does not parse a file that names no handler type, nor one with syntax errors", async () => {
    expect(await findings(`package club
func ListPlayers(name string) { db.Query("SELECT " + name) }
`)).toEqual([]);
    expect(await findings(`package club
import "github.com/gin-gonic/gin"
func ListPlayers(c *gin.Context) { db.Query("SELECT " + c.Query("a")
`)).toEqual([]);
  });
});
