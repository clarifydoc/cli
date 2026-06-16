import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { goSpec } from "./index.js";

const GO_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128",
  "byte", "rune", "string", "bool", "error",
  "any", "comparable",
  "map", "chan", "interface",
]);

export const goMeta: LanguagePluginMeta = {
  language: "go",
  parsing: "regex",
  extensions: goSpec.extensions,
  regexSpec: goSpec,
  builtinTypes: GO_BUILTINS,
  externalModulePrefixes: [
    "fmt", "net/", "os", "io", "context", "strings", "strconv", "errors", "encoding/",
    "crypto/", "database/", "log", "sync", "time", "testing",
  ],
  complexity: {
    branchNodes: new Set([
      "if_statement", "for_statement", "expression_switch_statement",
      "type_switch_statement", "select_statement", "case_clause",
    ]),
    logicalOps: new Set(["&&", "||"]),
  },
  frameworkImportHints: {
    "gorm.io/gorm": "gorm",
    "github.com/jmoiron/sqlx": "sqlx",
    "entgo.io/ent": "ent",
    "github.com/beego/beego": "beego-orm",
    "github.com/astaxie/beego": "beego-orm",
    "github.com/Masterminds/squirrel": "squirrel",
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call_expression", "composite_literal"]) },
};
