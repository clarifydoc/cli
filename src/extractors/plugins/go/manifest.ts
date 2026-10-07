import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { goFrameworkRules } from "./frameworks.js";
import { goPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const goManifest: LanguagePluginManifest = {
  language: "go",
  family: "go",
  importsNameDirectories: true,
  packageManagers: [goPackageManager],
  packageEcosystems: ["go"],
  parsing: "regex",
  extensions: [".go"],
  // One type spans files here: a type's methods sit in any file of its package directory.
  typesSpanFiles: true,
  testFilePatterns: [/_test\.go$/],
  // protoc and protoc-gen-grpc-gateway output.
  generatedFilePatterns: [/\.pb\.go$/, /\.pb\.gw\.go$/],
  externalModulePrefixes: ["fmt", "net/", "os", "io", "context", "strings", "strconv", "errors", "encoding/", "crypto/", "database/", "log", "sync", "time", "testing"],
  frameworkImportHints: { "gorm.io/gorm": "gorm", "github.com/jmoiron/sqlx": "sqlx", "entgo.io/ent": "ent", "github.com/beego/beego": "beego-orm", "github.com/astaxie/beego": "beego-orm", "github.com/Masterminds/squirrel": "squirrel" },
  frameworkRules: goFrameworkRules,
  activationFiles: ["go.mod"],
};
