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
      "get_orders <- function(con, status = \"open\") {",
      "  rows <- dbGetQuery(con, \"SELECT id FROM orders\")",
      "  if (nrow(rows) > 0 && !is.null(status)) format_rows(rows) else NULL",
      "}",
      "\"%+%\" <- function(a, b) paste0(a, b)",
      "Repo <- R6::R6Class(\"Repo\", inherit = BaseRepo,",
      "  public = list(con = NULL, initialize = function(con) self$con <- con, all = function() dbReadTable(self$con, \"orders\")),",
      "  private = list(secret = function() helper()))",
      "setClass(\"Account\", representation(id = \"numeric\", owner = \"character\"))",
      "setMethod(\"balance\", \"Account\", function(obj) fetch_balance(obj@id))",
    ].join("\n"));
    const fns = a.functions.filter((f) => f.name !== "<setup>");
    expect(fns.map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([
      ["get_orders", ["con", "status"]], ["%+%", ["a", "b"]],
    ]);
    expect(fns[0]!.calls.map((c) => c.name)).toEqual(["dbGetQuery", "nrow", "format_rows"]);
    expect(a.complexities?.find((c) => c.functionName === "get_orders")?.complexity).toBe(3);
    const classes = Object.fromEntries(a.classes.map((c) => [c.name, c]));
    expect(classes.Repo!.extends).toBe("BaseRepo");
    expect(classes.Repo!.methods.map((m) => [m.name, m.isExported])).toEqual([["Repo", true], ["all", true], ["secret", false]]);
    expect(classes.Account!.properties.map((p) => [p.name, p.type])).toEqual([["id", "numeric"], ["owner", "character"]]);
    expect(classes.Account!.methods.map((m) => [m.name, m.calls.map((c) => c.name)])).toEqual([["balance", ["fetch_balance"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["DBI", "R/db.R"]);
  });
});

describe("R routes", () => {
  it("reads Plumber annotations and the programmatic API", async () => {
    const a = await analyze([
      "#* @param status:str",
      "#* @get /api/orders",
      "#* @head /api/orders",
      "function(status = \"open\") list_orders(status)",
      "",
      "#* @post /api/orders/<id:int>/close",
      "close_handler <- function(id) close_order(id)",
      "",
      "# an ordinary comment",
      "helper <- function() 1",
      "pr() |> pr_get(\"/health\", function() \"ok\") |> pr_delete(\"/api/orders/<id>\", delete_order)",
    ].join("\n"), "plumber.R");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /api/orders -> null [list_orders]",
      "HEAD /api/orders -> null [list_orders]",
      "POST /api/orders/{id}/close -> close_handler []",
      "GET /health -> null []",
      "DELETE /api/orders/{id} -> delete_order []",
    ]);
    expect(a.routes[0]!.params).toEqual([{ name: "status", type: "str", binding: "query" }]);
  });
});

describe("R data access", () => {
  it("reads SQL in strings, DBI tables and HTTP calls", async () => {
    const a = await analyze([
      "f <- function(con, id) {",
      "  dbExecute(con, \"UPDATE orders SET status = 'closed' WHERE id = $1\")",
      "  dbWriteTable(con, \"audit\", log_df, append = TRUE)",
      "  tbl(con, \"customers\")",
      "  httr::POST(paste0(Sys.getenv(\"CRM_URL\"), \"/v2/customers/\", id), body = list())",
      "  httr2::request(\"https://api.example.com/health\")",
      "  message(\"Select an item from the list\")",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => [d.kind, d.name, d.entity, d.access, d.baseEnv && `(${d.baseEnv})`].filter(Boolean).join(" "))).toEqual([
      "database UPDATE orders write",
      "database dbWriteTable audit write",
      "database tbl customers read",
      "api-call POST /v2/customers/{id} (CRM_URL)",
      "api-call GET https://api.example.com/health",
    ]);
  });
});

describe("Shiny", () => {
  it("reads the UI page as a screen and the observers as what its inputs do", async () => {
    const a = await analyze([
      "ui <- fluidPage(titlePanel(\"Orders\"), sidebarLayout(sidebarPanel(textInput(\"customer\", \"Customer\"), actionButton(\"save\", \"Save\")), mainPanel(tableOutput(\"orders\"))))",
      "server <- function(input, output, session) {",
      "  observeEvent(input$save, { req(input$customer); save_order(input$customer) })",
      "  observeEvent(input$customer, refresh_suggestions(input$customer))",
      "}",
    ].join("\n"), "app.R");
    const walk = (c: { componentType: string; name: string; children: never[] }): string =>
      c.componentType + ":" + c.name + (c.children.length ? `[${c.children.map(walk).join(",")}]` : "");
    expect(a.screens?.map((s) => [s.name, s.caption, s.components.map((c) => walk(c as never))])).toEqual([
      ["ui", "Orders", ["sidebarLayout:sidebarLayout[sidebarPanel:sidebarPanel[textInput:customer,actionButton:save],mainPanel:mainPanel[tableOutput:orders]]"]],
    ]);
    expect(a.interactiveElements.map((e) => `${e.element} ${e.event} -> ${e.handler}`)).toEqual([
      "button click -> save_order", "input change -> refresh_suggestions",
    ]);
  });
});
