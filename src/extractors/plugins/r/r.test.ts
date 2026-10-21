import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "R/app.R"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "r-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "r" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "r-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("R functions, classes and imports", () => {
  it("reads assigned functions, R6 / S4 classes and their methods", async () => {
    const a = await analyze([
      "library(DBI)",
      'source("R/db.R")',
      "get_cars <- function(con, status = \"open\") {",
      "  rows <- dbGetQuery(con, \"SELECT id FROM cars\")",
      "  if (nrow(rows) > 0 && !is.null(status)) format_rows(rows) else NULL",
      "}",
      "\"%+%\" <- function(a, b) paste0(a, b)",
      "Repo <- R6::R6Class(\"Repo\", inherit = BaseRepo,",
      "  public = list(con = NULL, initialize = function(con) self$con <- con, all = function() dbReadTable(self$con, \"cars\")),",
      "  private = list(secret = function() helper()))",
      "setClass(\"Club\", representation(id = \"numeric\", owner = \"character\"))",
      "setMethod(\"balance\", \"Club\", function(obj) fetch_balance(obj@id))",
    ].join("\n"));
    const fns = a.functions.filter((f) => f.name !== "<setup>");
    expect(fns.map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([
      ["get_cars", ["con", "status"]], ["%+%", ["a", "b"]],
    ]);
    expect(fns[0]!.calls.map((c) => c.name)).toEqual(["dbGetQuery", "nrow", "format_rows"]);
    expect(a.complexities?.find((c) => c.functionName === "get_cars")?.complexity).toBe(3);
    const classes = Object.fromEntries(a.classes.map((c) => [c.name, c]));
    expect(classes.Repo!.extends).toBe("BaseRepo");
    expect(classes.Repo!.methods.map((m) => [m.name, m.isExported])).toEqual([["Repo", true], ["all", true], ["secret", false]]);
    expect(classes.Club!.properties.map((p) => [p.name, p.type])).toEqual([["id", "numeric"], ["owner", "character"]]);
    expect(classes.Club!.methods.map((m) => [m.name, m.calls.map((c) => c.name)])).toEqual([["balance", ["fetch_balance"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["DBI", "R/db.R"]);
  });
});

describe("R routes", () => {
  it("reads Plumber annotations and the programmatic API", async () => {
    const a = await analyze([
      "#* @param status:str",
      "#* @get /api/cars",
      "#* @head /api/cars",
      "function(status = \"open\") list_cars(status)",
      "",
      "#* @post /api/cars/<id:int>/close",
      "close_handler <- function(id) close_car(id)",
      "",
      "# an ordinary comment",
      "helper <- function() 1",
      "pr() |> pr_get(\"/health\", function() \"ok\") |> pr_delete(\"/api/cars/<id>\", delete_car)",
    ].join("\n"), "plumber.R");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /api/cars -> null [list_cars]",
      "HEAD /api/cars -> null [list_cars]",
      "POST /api/cars/{id}/close -> close_handler []",
      "GET /health -> null []",
      "DELETE /api/cars/{id} -> delete_car []",
    ]);
    expect(a.routes[0]!.params).toEqual([{ name: "status", type: "str", binding: "query" }]);
  });
});

describe("R data access", () => {
  it("reads SQL in strings, DBI tables and HTTP calls", async () => {
    const a = await analyze([
      "f <- function(con, id) {",
      "  dbExecute(con, \"UPDATE cars SET status = 'closed' WHERE id = $1\")",
      "  dbWriteTable(con, \"audit\", log_df, append = TRUE)",
      "  tbl(con, \"drivers\")",
      "  httr::POST(paste0(Sys.getenv(\"CRM_URL\"), \"/v2/drivers/\", id), body = list())",
      "  httr2::request(\"https://api.example.com/health\")",
      "  message(\"Select an item from the list\")",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => [d.kind, d.name, d.entity, d.access, d.baseEnv && `(${d.baseEnv})`].filter(Boolean).join(" "))).toEqual([
      "database UPDATE cars write",
      "database dbWriteTable audit write",
      "database tbl drivers read",
      "api-call POST /v2/drivers/{id} (CRM_URL)",
      "api-call GET https://api.example.com/health",
    ]);
  });
});

describe("Shiny", () => {
  it("reads the UI page as a screen and the observers as what its inputs do", async () => {
    const a = await analyze([
      "ui <- fluidPage(titlePanel(\"Cars\"), sidebarLayout(sidebarPanel(textInput(\"driver\", \"Driver\"), actionButton(\"save\", \"Save\")), mainPanel(tableOutput(\"cars\"))))",
      "server <- function(input, output, session) {",
      "  observeEvent(input$save, { req(input$driver); save_car(input$driver) })",
      "  observeEvent(input$driver, refresh_suggestions(input$driver))",
      "}",
    ].join("\n"), "app.R");
    const walk = (c: { componentType: string; name: string; children: never[] }): string =>
      c.componentType + ":" + c.name + (c.children.length ? `[${c.children.map(walk).join(",")}]` : "");
    expect(a.screens?.map((s) => [s.name, s.caption, s.components.map((c) => walk(c as never))])).toEqual([
      ["ui", "Cars", ["sidebarLayout:sidebarLayout[sidebarPanel:sidebarPanel[textInput:driver,actionButton:save],mainPanel:mainPanel[tableOutput:cars]]"]],
    ]);
    expect(a.interactiveElements.map((e) => `${e.element} ${e.event} -> ${e.handler}`)).toEqual([
      "button click -> save_car", "input change -> refresh_suggestions",
    ]);
  });
});
