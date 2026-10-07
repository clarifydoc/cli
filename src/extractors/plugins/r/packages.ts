import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** CRAN package recognition. */
export const cranPackages: readonly KnownPackageRule[] = [
  { names: ["plumber", "plumber2"], category: "framework", framework: { id: "plumber", name: "Plumber" } },
  { names: ["shiny"], category: "frontend", framework: { id: "shiny", name: "Shiny" } },
  { names: ["golem", "rhino"], category: "framework", framework: { id: "shiny", name: "Shiny" } },
  { names: ["shinydashboard", "bslib", "shinyWidgets", "DT", "reactable"], category: "ui" },
  { names: ["DBI", "RPostgres", "RPostgreSQL", "RMariaDB", "RMySQL", "RSQLite", "odbc", "RODBC", "duckdb", "pool"], category: "database" },
  { names: ["dbplyr", "dm"], category: "orm" },
  { names: ["httr", "httr2", "curl", "RCurl", "crul"], category: "http" },
  { names: ["jsonlite", "yaml", "xml2", "arrow"], category: "serialization" },
  { names: ["testthat", "tinytest", "shinytest2", "covr"], category: "testing" },
  { names: ["lintr", "styler"], category: "lint" },
  { names: ["logger", "futile.logger", "log4r"], category: "logging" },
  { names: ["dplyr", "tidyr", "purrr", "stringr", "glue", "R6", "rlang", "magrittr", "data.table", "lubridate"], category: "util" },
];
