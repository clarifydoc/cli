import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { viewLiterals } from "./rendered-views.js";
import type { ProjectAnalysis } from "../types/analysis.js";

describe("viewLiterals", () => {
  it("reads render calls, view fields and returned names", () => {
    expect(viewLiterals(`let text = PageData::new("admin/clubs", json!(rows)).render()?;`)).toEqual(["admin/clubs"]);
    expect(viewLiterals(`return render_template("league/table.html", rows=rows)`)).toEqual(["league/table.html"]);
    expect(viewLiterals(`let json = json!({ "page_content": "admin/login", "error": msg });`)).toEqual(["admin/login"]);
    expect(viewLiterals(`model.addAttribute("cars", cars);\n        return "garage/list";`)).toEqual(["garage/list"]);
    expect(viewLiterals(`c.HTML(http.StatusOK, "match.tmpl", gin.H{})`)).toEqual(["match.tmpl"]);
    expect(viewLiterals(`fetch("https://example.com/x"); log("render done")`)).toEqual([]);
  });
});

/** Real-repo FP: a Rocket admin whose handlers render `admin/<page>` through a page struct; 7 template screens had no route. */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "src/api/admin.rs": `use rocket::response::content::RawHtml as Html;

struct PageData {
    page_content: String,
}

impl PageData {
    fn new(page_content: &str, data: Value) -> Self {
        Self { page_content: String::from(page_content) }
    }

    fn render(self) -> Result<String, Error> {
        CONFIG.render_template(BASE_TEMPLATE, &self)
    }
}

fn render_login(msg: Option<&str>) -> ApiResult<Html<String>> {
    let json = json!({ "page_content": "admin/login", "error": msg });
    let text = CONFIG.render_template(BASE_TEMPLATE, &json)?;
    Ok(Html(text))
}

#[get("/login")]
fn login_page() -> ApiResult<Html<String>> {
    render_login(None)
}

#[get("/clubs/overview")]
async fn clubs_overview(conn: DbConn) -> ApiResult<Html<String>> {
    let clubs = Club::get_all(&conn).await;
    let text = PageData::new("admin/clubs", json!(clubs)).render()?;
    Ok(Html(text))
}

#[get("/clubs")]
fn get_clubs_json(conn: DbConn) -> Json<Value> {
    Json(Club::get_all(&conn))
}
`,
  "src/static/templates/admin/login.hbs": `<form method="post" action="{{urlpath}}/admin"><input name="token"><button type="submit">Enter</button></form>\n`,
  "src/static/templates/admin/clubs.hbs": `<h1>Clubs</h1>\n{{#each page_data}}<tr><td>{{name}}</td><td><button type="button" vw-delete-club>Delete</button></td></tr>{{/each}}\n`,
};

describe("a route renders the template it names", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rendered-views-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives each template screen the route that renders it", () => {
    const screen = (f: string) => summary.screens.find((s) => s.filePath === f);
    expect(screen("src/static/templates/admin/clubs.hbs")).toMatchObject({ routePath: "/clubs/overview", renderedBy: [{ method: "GET", path: "/clubs/overview" }] });
    // Through a helper the handler calls.
    expect(screen("src/static/templates/admin/login.hbs")).toMatchObject({ routePath: "/login" });
  });
});
